// The agent loop. It is UI-AGNOSTIC: it emits AgentEvents through an injected sink
// and NEVER console.logs or returns strings to a UI. All safety rails live here:
// max-iterations guard, structured tool errors fed back (never thrown out), content:null
// + finish_reason handling, sequential tool calls, cancellation, and the invariant that
// EVERY assistant tool_call gets a matching tool result so the next request never 400s.
import type OpenAI from "openai";
import { client as defaultClient } from "./client.ts";
import { config } from "./config.ts";
import type { Session } from "./session.ts";
import type { Logger } from "./log.ts";
import { Registry, toToolMessage, type ToolContext } from "./tools/index.ts";
import { type ApprovalGate, AutoDenyGate } from "./approvals.ts";
import type { AgentEvent, AgentEventBody, EventSink } from "./events.ts";

// No practical limit on a task — this is only a catastrophic backstop against a runaway
// loop burning tokens forever. Real termination comes from stuck-detection (below).
const MAX_ITERATIONS = 300;

// Tools that legitimately repeat (reading/looking/navigating) — never count as "stuck".
const REPEATABLE = new Set([
  "browser_read",
  "browser_navigate",
  "browser_scroll",
  "list_files",
  "read_file",
  "web_search",
  "web_fetch",
  "get_date",
  "echo",
]);
// Same exact action (e.g. clicking the same element) this many times = genuinely stuck.
const STUCK_THRESHOLD = 6;

export interface RunnerOpts {
  session: Session;
  sink: EventSink;
  registry: Registry;
  model: string;
  logger: Logger;
  runId?: string;
  gate?: ApprovalGate; // how gated tools get human approval (default: deny all)
  workspaceRoot?: string;
  roots?: string[]; // allowed read/write roots (defaults to [workspaceRoot])
  startSeq?: number; // resume seq after rehydrating a persisted run (avoids seq collisions)
  client?: OpenAI; // which OpenAI-compatible endpoint (default: the OpenRouter singleton)
  stream?: boolean; // small local models do tool-calling better non-streamed (default: true)
}

export class AgentRunner {
  readonly runId: string;
  private seq = 0;
  private turnId = "";
  private started = false;
  private gate: ApprovalGate;
  private workspaceRoot: string;
  private roots: string[];

  private readonly client: OpenAI;
  private readonly stream: boolean;

  constructor(private o: RunnerOpts) {
    this.runId = o.runId ?? crypto.randomUUID();
    this.gate = o.gate ?? new AutoDenyGate();
    this.workspaceRoot = o.workspaceRoot ?? config.workspaceRoot;
    this.roots = o.roots ?? [this.workspaceRoot];
    this.seq = o.startSeq ?? 0;
    this.started = (o.startSeq ?? 0) > 0; // a rehydrated run already emitted run.started
    this.client = o.client ?? defaultClient;
    this.stream = o.stream ?? true;
  }

  private async emit(body: AgentEventBody): Promise<void> {
    const event: AgentEvent = {
      ...body,
      runId: this.runId,
      turnId: this.turnId,
      seq: this.seq++,
      ts: Date.now(),
    };
    this.o.logger.log("event", event);
    await this.o.sink.emit(event);
  }

  // One user message -> runs to completion (final answer, error, or cancellation).
  async send(userInput: string, signal: AbortSignal): Promise<string> {
    this.turnId = crypto.randomUUID();
    if (!this.started) {
      this.started = true;
      await this.emit({ type: "run.started", title: userInput.slice(0, 80) });
    }
    this.o.session.pushUser(userInput);
    await this.emit({ type: "user.message", text: userInput });

    const callCounts = new Map<string, number>(); // same-action repetition, for stuck-detection
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      await this.emit({ type: "turn.started", index: i, maxIterations: MAX_ITERATIONS });

      // Get the completion. STREAMED (cloud default): emit the visible reply token-by-token
      // (message.delta) so the Run View feels alive; tool_call deltas arrive piecemeal (by index)
      // and are reassembled. NON-STREAMED (small local models do tool-calling far better this way):
      // one response, no deltas. Either way we end up with the same content/toolCalls/reasoning, so
      // the tool-execution logic below is identical. Reasoning is logged but NEVER streamed raw.
      let content = "";
      let reasoning = "";
      let finishReason: string | null = null;
      let usage: unknown = null;
      const toolAcc: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
      const baseArgs = {
        model: this.o.model,
        messages: this.o.session.messages,
        tools: this.o.registry.schemas(),
        tool_choice: "auto" as const,
        parallel_tool_calls: false, // INVARIANT
      };
      try {
        if (this.stream) {
          const stream = await this.client.chat.completions.create(
            { ...baseArgs, stream: true, stream_options: { include_usage: true } },
            { signal },
          );
          for await (const chunk of stream) {
            if (chunk.usage) usage = chunk.usage;
            const ch = chunk.choices?.[0];
            if (!ch) continue;
            if (ch.finish_reason) finishReason = ch.finish_reason;
            const delta = ch.delta as any;
            if (typeof delta?.content === "string" && delta.content) {
              content += delta.content;
              await this.emit({ type: "message.delta", text: delta.content });
            }
            const r = delta?.reasoning ?? delta?.reasoning_content;
            if (typeof r === "string" && r) reasoning += r;
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === "number" ? tc.index : toolAcc.length;
                const acc = (toolAcc[idx] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.function.name += tc.function.name;
                if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
              }
            }
          }
        } else {
          const res = await this.client.chat.completions.create(baseArgs, { signal });
          const m: any = res.choices?.[0]?.message ?? {};
          content = typeof m.content === "string" ? m.content : "";
          reasoning = typeof m.reasoning === "string" ? m.reasoning : typeof m.reasoning_content === "string" ? m.reasoning_content : "";
          finishReason = res.choices?.[0]?.finish_reason ?? null;
          usage = res.usage ?? null;
          for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
            const a = tc.function?.arguments;
            // Some local servers return arguments as a parsed object, not a JSON string —
            // normalize to a string since the registry JSON.parses it.
            const argStr = typeof a === "string" ? a : a != null ? JSON.stringify(a) : "";
            toolAcc.push({ id: tc.id ?? "", type: "function", function: { name: tc.function?.name ?? "", arguments: argStr } });
          }
          // No deltas were streamed; the reply (if no tools) is emitted via message.completed below.
        }
      } catch (err: any) {
        if (signal.aborted || err?.name === "AbortError") {
          await this.emit({ type: "run.error", kind: "cancelled", userMessage: "Okay, I stopped.", recoverable: true });
          return "";
        }
        this.o.logger.log("transport_error", String(err?.stack ?? err));
        await this.emit({
          type: "run.error",
          kind: "transport",
          userMessage: "I had trouble connecting just now. Want to try again?",
          recoverable: true,
        });
        return "";
      }

      const toolCalls = toolAcc.filter(Boolean);
      const msg = {
        role: "assistant" as const,
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      this.o.session.pushAssistant(msg as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      if (usage) this.o.logger.log("usage", usage);

      // Never surface raw chain-of-thought — log it, emit a safe summary only.
      if (reasoning.trim()) {
        this.o.logger.log("reasoning", reasoning);
        await this.emit({ type: "thinking.summary", summary: "Worked out the next step." });
      }

      if (finishReason === "length") {
        await this.emit({
          type: "run.error",
          kind: "length",
          userMessage: "That turned out bigger than expected, so I stopped — nothing was changed.",
          recoverable: false,
        });
        return content;
      }
      if (finishReason === "content_filter") {
        await this.emit({ type: "run.error", kind: "content_filter", userMessage: "I can't help with that part.", recoverable: false });
        return content;
      }

      if (toolCalls.length === 0) {
        const text = content;
        if (text) await this.emit({ type: "message.completed", text });
        // Tell the UI what actually changed (drives the Summary recap + Undo-all).
        const changes = this.o.session.journal.list().map((e) => ({
          summary: e.description,
          reversibility: e.reversibility,
          undoable: typeof e.inverse === "function",
          journaledOpId: e.id,
        }));
        await this.emit({ type: "run.finished", status: "completed", finalMessage: text, changes });
        return text;
      }

      // Sequential tool execution. EVERY call MUST get a tool result appended (ordering
      // invariant) — the `finally` backfills any call left unresolved (cancel, throw,
      // a denied gate) so session.messages never strands a tool_call and 400s next turn.
      const ctx: ToolContext = {
        signal,
        journal: this.o.session.journal,
        runId: this.runId,
        workspaceRoot: this.workspaceRoot,
        roots: this.roots,
        onScreenshot: (dataUrl) => {
          void this.emit({ type: "screenshot", dataUrl });
        },
      };
      const resolvedCalls = new Set<string>();
      let cancelled = false;
      const pushResult = (callId: string, content: string) => {
        this.o.session.pushToolResult(callId, content);
        resolvedCalls.add(callId);
      };

      try {
        for (const call of toolCalls) {
          if (cancelled) break;
          const callId = call.id;
          if (call.type !== "function") {
            pushResult(callId, toToolMessage({ ok: false, error: "unsupported_call_type" }));
            continue;
          }
          const prep = this.o.registry.prepare(call.function.name, call.function.arguments);
          if (!prep.ok) {
            this.o.logger.log("tool_prepare_failed", { name: call.function.name, reason: prep.reason });
            await this.emit({ type: "tool.proposed", callId, action: "(couldn't understand that step)", reversibility: "reversible" });
            await this.emit({ type: "tool.result", callId, ok: false, summary: prep.userSummary });
            pushResult(callId, toToolMessage({ ok: false, summary: prep.userSummary, error: prep.reason }));
            continue;
          }

          const { tool, args, description } = prep;

          // Stuck-detection: a non-repeatable action (a click/type/file-op) repeated with
          // the exact same args many times means the model is looping — stop, don't churn.
          if (!REPEATABLE.has(tool.name)) {
            const sig = `${tool.name}:${JSON.stringify(args)}`;
            const n = (callCounts.get(sig) ?? 0) + 1;
            callCounts.set(sig, n);
            if (n >= STUCK_THRESHOLD) {
              await this.emit({
                type: "run.error",
                kind: "max_iterations",
                userMessage: "I kept trying the same step without getting anywhere, so I paused. Want me to try a different way?",
                recoverable: true,
              });
              return "";
            }
          }

          await this.emit({
            type: "tool.proposed",
            callId,
            action: description.action,
            detail: description.detail,
            reversibility: description.reversibility,
          });

          // Confirm when a tool always gates (file mutations, shell) OR when this specific
          // action isn't reversible (a risky browser click). Benign, reversible actions —
          // routine UI clicks, navigation, scrolling — run autonomously, no prompt.
          const needsApproval = tool.gated || description.reversibility !== "reversible";
          if (needsApproval) {
            const items = description.items ?? [];
            const shown = items.slice(0, 5);
            const overflow = items.length > shown.length ? items.length - shown.length : undefined;
            const reqInfo = {
              callId,
              action: description.action,
              consequences: description.consequences ?? "",
              items: shown,
              overflowCount: overflow,
              reversibility: description.reversibility,
            };
            // "Yes to all (this errand)" auto-approves ONLY reversible actions — never
            // permanent/unknown ones, which always pause no matter what.
            const auto =
              description.reversibility === "reversible" && this.gate.autoApproves?.(reqInfo) === true;
            if (auto) {
              await this.emit({ type: "approval.resolved", callId, decision: "approved" });
            } else {
              await this.emit({ type: "approval.required", ...reqInfo });
              const decision = await this.gate.request(reqInfo, signal); // never rejects
              await this.emit({ type: "approval.resolved", callId, decision });
              if (decision !== "approved") {
                const userSummary =
                  decision === "denied"
                    ? "Okay, I left that alone."
                    : decision === "cancelled"
                      ? "Stopped."
                      : "That request timed out.";
                await this.emit({ type: "tool.result", callId, ok: false, summary: userSummary });
                pushResult(callId, toToolMessage({ ok: false, error: `approval_${decision}` }));
                if (decision === "cancelled") cancelled = true; // stop the whole run
                continue; // denied/expired: model continues and sees the refusal next turn
              }
            }

            // Commit-time pre-flight: re-check after the (unbounded) human pause. State
            // may have drifted (token expired, recipient changed). ok:false → don't run.
            if (tool.preflight) {
              let pf;
              try {
                pf = await tool.preflight(args, ctx);
              } catch {
                pf = { ok: false as const, userSummary: "Something changed, so I didn't go ahead." };
              }
              if (!pf.ok) {
                await this.emit({ type: "tool.result", callId, ok: false, summary: pf.userSummary });
                pushResult(callId, toToolMessage({ ok: false, error: "preflight_failed", summary: pf.userSummary }));
                continue;
              }
            }
          }

          await this.emit({ type: "tool.started", callId, action: description.action });
          // A permanent/unknown action interrupted mid-run leaves us unable to know if it
          // committed → mark uncertain so the model NEVER blindly retries (double-send guard).
          const permanent = description.reversibility !== "reversible";
          let result: import("./tools/index.ts").ToolResult;
          try {
            result = await tool.run(args, ctx);
          } catch (err: any) {
            this.o.logger.log("tool_error", { name: tool.name, err: String(err?.stack ?? err) });
            result = {
              ok: false,
              outcome: permanent ? "uncertain" : "failed",
              error: String(err?.message ?? err),
            };
          }
          const uncertain = result.outcome === "uncertain";
          const summary = uncertain
            ? "I'm not certain that finished — please check before trying it again."
            : tool.summarize(result) || (result.ok ? "Done." : "That step didn't work.");
          await this.emit({ type: "tool.result", callId, ok: result.ok, summary, bytes: result.bytes });
          // For uncertain permanent actions, tell the model explicitly NOT to retry.
          pushResult(
            callId,
            toToolMessage(
              uncertain
                ? {
                    ok: false,
                    outcome: "uncertain",
                    error: result.error,
                    summary:
                      "UNCERTAIN: this may or may not have completed. Do NOT repeat it; ask the user to verify.",
                  }
                : result,
            ),
          );
        }
      } finally {
        // INVARIANT: backfill any tool_call left without a result.
        for (const call of toolCalls) {
          if (!resolvedCalls.has(call.id)) {
            pushResult(call.id, toToolMessage({ ok: false, error: "unresolved" }));
          }
        }
      }

      if (cancelled) {
        await this.emit({ type: "run.error", kind: "cancelled", userMessage: "Okay, I stopped.", recoverable: true });
        return "";
      }
      // loop continues — the model now sees the tool results
    }

    await this.emit({
      type: "run.error",
      kind: "max_iterations",
      userMessage: "This is taking more steps than I'd expect, so I paused. Here's what I've done so far.",
      recoverable: true,
    });
    return "";
  }
}
