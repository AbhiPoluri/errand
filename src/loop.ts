// The agent loop. It is UI-AGNOSTIC: it emits AgentEvents through an injected sink
// and NEVER console.logs or returns strings to a UI. All safety rails live here:
// max-iterations guard, structured tool errors fed back (never thrown out), content:null
// + finish_reason handling, sequential tool calls, cancellation, and the invariant that
// EVERY assistant tool_call gets a matching tool result so the next request never 400s.
import type OpenAI from "openai";
import { client as defaultClient } from "./client.ts";
import { config } from "./config.ts";
import type { Session } from "./session.ts";
import { backfillToolResults } from "./session.ts";
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
  vision?: boolean; // feed page screenshots to the model after browser actions (needs a vision model)
  checkpoint?: (state: TurnState) => void; // persist mid-turn state for resumability (default: no-op)
  // Irreversible-double-execution guard: the host persists a tool_inflight marker while a
  // permanent/unknown tool runs, so a crash mid-run is detected on resume (marked uncertain, not
  // re-run). Both no-ops by default (reversible tools never mark). See executeTools + store.tool_inflight.
  markInflight?: (callId: string, toolName: string, reversibility: string) => void;
  clearInflight?: (callId: string) => void;
}

// A durable mid-turn checkpoint: the model's exact (400-safe) messages array plus enough loop
// position to re-enter the loop at the right boundary on resume. Persisted by the host via the
// `checkpoint` callback and consumed by AgentRunner.resume() (below). One in-flight turn per run.
export interface TurnState {
  turnId: string;
  phase: "executing_tools" | "awaiting_approval";
  iteration: number;
  callCursor: number; // how many of this turn's tool_calls have a real result so far
  pendingCallId: string | null; // the call awaiting approval (phase=awaiting_approval), else null
  messages: unknown[]; // backfillToolResults(session.messages) — never strands a tool_call
  callCounts: Record<string, number>; // stuck-detection counters
  maxEmittedSeq: number; // seq high-water, so resume continues the SSE stream without collisions
}

// What AgentRunner.resume() needs from a persisted checkpoint to re-enter the interrupted turn. A
// store TurnStateRow is structurally assignable to this (it carries every field, plus extras resume
// ignores). Deliberately NOT importing the store type — loop.ts must never pull in node:sqlite.
export interface ResumeState {
  turnId: string;
  iteration: number;
  callCursor: number;
  pendingCallId: string | null;
  messages: unknown[]; // the 400-safe in-flight snapshot (turn_state.messages)
  callCounts: Record<string, number>;
}

// A single normalized tool_call as the loop executes it. Matches both the streamed accumulator shape
// and an assistant message's persisted tool_calls, so resume can re-run calls read back from a snapshot.
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// The outcome of one model completion: either a terminal exit (its event already emitted) or the
// tool_calls to execute this iteration.
type CompleteResult = { kind: "terminal"; text: string } | { kind: "tools"; toolCalls: ToolCall[] };
// The outcome of executing a turn's tool calls: a terminal exit (stuck/cancelled) or continue the loop.
type ExecResult = { kind: "terminal"; text: string } | { kind: "continue" };

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
  private readonly vision: boolean;

  constructor(private o: RunnerOpts) {
    this.runId = o.runId ?? crypto.randomUUID();
    this.gate = o.gate ?? new AutoDenyGate();
    this.workspaceRoot = o.workspaceRoot ?? config.workspaceRoot;
    this.roots = o.roots ?? [this.workspaceRoot];
    this.seq = o.startSeq ?? 0;
    this.started = (o.startSeq ?? 0) > 0; // a rehydrated run already emitted run.started
    this.client = o.client ?? defaultClient;
    this.stream = o.stream ?? true;
    this.vision = o.vision ?? false;
  }

  private async emit(body: AgentEventBody): Promise<void> {
    // `seq` is the DURABLE ordering key: it is the events-table primary key AND the SSE
    // Last-Event-ID a client resumes from. Only STRUCTURAL (persisted) events advance it, so the
    // persisted seq space stays contiguous and a rehydrated run's startSeq = maxPersistedSeq + 1
    // is always strictly greater than any seq a client has ever seen. message.delta is the lone
    // per-token event that is never persisted; if it advanced `seq`, the live counter would outrun
    // the persisted max by the number of streamed tokens, and after a restart a NEW structural
    // event could be minted at a seq a live tab already consumed via a delta — silently skipped on
    // reconnect (it sits below the tab's Last-Event-ID). So a delta instead BORROWS the seq of the
    // preceding structural event (`this.seq - 1`): it still sorts right after that event and
    // strictly before the next structural one, and is filtered out on any reconnect past it. The
    // final reply text always rides on the structural message.completed, so a dropped delta is
    // lossless. (The reducer appends delta text and there is no seq-dedup, so a shared seq is safe.)
    const isDelta = body.type === "message.delta";
    const seq = isDelta ? Math.max(0, this.seq - 1) : this.seq++;
    const event: AgentEvent = {
      ...body,
      runId: this.runId,
      turnId: this.turnId,
      seq,
      ts: Date.now(),
    };
    // Skip the per-token deltas: Logger.log is a synchronous appendFileSync, so logging every
    // streamed token serializes the stream behind disk latency. The final text is reconstructed
    // from message.completed, so per-delta logs carry no diagnostic value. Structural events
    // (tool calls, approvals, errors, usage) are still logged.
    if (!isDelta) this.o.logger.log("event", event);
    await this.o.sink.emit(event);
  }

  // Persist a mid-turn checkpoint (no-op unless the host injected `checkpoint`). The messages are
  // backfilled to be 400-safe (no stranded tool_call). A checkpoint failure must NEVER break the
  // turn, so it's fully swallowed — the loop runs identically with or without persistence.
  private saveCheckpoint(
    phase: TurnState["phase"],
    iteration: number,
    callCursor: number,
    pendingCallId: string | null,
    callCounts: Map<string, number>,
  ): void {
    if (!this.o.checkpoint) return;
    try {
      this.o.checkpoint({
        turnId: this.turnId,
        phase,
        iteration,
        callCursor,
        pendingCallId,
        messages: backfillToolResults(this.o.session.messages),
        callCounts: Object.fromEntries(callCounts),
        // The MAX seq ACTUALLY EMITTED so far, not the next one. `this.seq` is pre-incremented on
        // every structural emit (seq = this.seq++), so after emitting a structural event with seq N,
        // `this.seq` is N+1 — the seq the NEXT event will get. The high-water mark is therefore
        // `this.seq - 1`. A resume consumer computes `startSeq = maxEmittedSeq + 1`; with the old
        // `this.seq` value that was maxEmitted+2 (a one-seq GAP), and any consumer that trusted it as
        // the last-seen id would have skipped the event at maxEmitted+1. -1 before the first emit
        // (this.seq === 0) matches the store's "no events yet" sentinel. Resume itself still derives
        // startSeq from the max PERSISTED event seq (which can exceed this after post-checkpoint
        // events), so this stays a truthful, collision-free lower bound in every consumer.
        maxEmittedSeq: this.seq - 1,
      });
    } catch {
      /* checkpoint failure must never interrupt the turn */
    }
  }

  // One user message -> runs to completion (final answer, error, or cancellation).
  async send(userInput: string, signal: AbortSignal): Promise<string> {
    return this.guarded(() => this.sendTurn(userInput, signal));
  }

  // Resume a persisted mid-turn checkpoint into a running loop (see resumeTurn). Shares send()'s
  // terminal-error boundary so a resume that throws still settles the run instead of hanging.
  async resume(state: ResumeState, signal: AbortSignal, inflight: Set<string> = new Set()): Promise<string> {
    return this.guarded(() => this.resumeTurn(state, signal, inflight));
  }

  // The shared turn-body guard: ANY exception that escapes (a throwing tool.summarize / tool.describe,
  // gate.autoApproves, a rejecting sink) becomes a TERMINAL run.error so the SSE stream closes and the
  // Run View settles — never a silent hang. The per-turn `finally` inside the body still runs first and
  // backfills tool results (the 400-safety), because it lives on the inner stack and unwinds before the
  // exception reaches here. All expected exits already emit their own terminal event and `return`, so
  // they never reach here — no double terminal event.
  private async guarded(body: () => Promise<string>): Promise<string> {
    try {
      return await body();
    } catch (err: any) {
      this.o.logger.log("loop_error", String(err?.stack ?? err));
      try {
        await this.emit({
          type: "run.error",
          kind: "internal",
          userMessage: "Something went wrong on my end — nothing was left half-done that I can't explain.",
          recoverable: false,
        });
      } catch {
        /* the sink itself is failing — nothing more we can do; the route still tears down the stream */
      }
      return "";
    }
  }

  private async sendTurn(userInput: string, signal: AbortSignal): Promise<string> {
    this.turnId = crypto.randomUUID();
    if (!this.started) {
      this.started = true;
      await this.emit({ type: "run.started", title: userInput.slice(0, 80) });
    }
    this.o.session.pushUser(userInput);
    await this.emit({ type: "user.message", text: userInput });
    const callCounts = new Map<string, number>(); // same-action repetition, for stuck-detection
    return this.runLoop(0, callCounts, signal);
  }

  // Re-enter a persisted mid-turn checkpoint. The interrupted turn's model completion ALREADY happened
  // (its assistant tool_calls message is in the snapshot) and its already-emitted events are persisted,
  // so we NEVER re-call the model for it — we resume from the persisted boundary: finish the turn's
  // remaining tool calls (re-parking a pending approval so /decision still resolves it), then continue
  // with fresh model iterations. `startSeq` (set at construction to maxPersistedSeq+1) keeps every new
  // event strictly above any seq a client already saw, so a reconnecting SSE stream neither drops nor
  // duplicates. The reconstructed message history is 400-safe (backfillToolResults), so the next model
  // call can't strand a tool_call — the approval-exit invariant holds across the restart.
  private async resumeTurn(state: ResumeState, signal: AbortSignal, inflight: Set<string>): Promise<string> {
    this.turnId = state.turnId || crypto.randomUUID();
    // Load the 400-safe in-flight snapshot, then peel it back to the pre-pending-call boundary so the
    // remaining calls genuinely re-run instead of looking already-resolved (see reconstructForResume).
    this.o.session.loadMessages(state.messages as any);
    const callCounts = new Map<string, number>(Object.entries(state.callCounts ?? {}));
    const { toolCalls, startCursor } = this.reconstructForResume(state);
    if (toolCalls.length) {
      const exec = await this.executeTools(toolCalls, state.iteration, callCounts, signal, startCursor, inflight);
      if (exec.kind === "terminal") return exec.text;
    }
    // The interrupted turn's tools are done; continue with new model iterations from the NEXT one.
    return this.runLoop(state.iteration + 1, callCounts, signal);
  }

  // Rebuild the session at the exact tool-execution boundary a checkpoint captured, and return the
  // turn's tool_calls + the cursor to resume from. The snapshot's messages end at the in-flight
  // assistant tool_calls message followed by tool results — the first `startCursor` are REAL (already
  // ran), the rest are the 400-safe "interrupted" PLACEHOLDERS. We keep the real ones and drop the
  // placeholders so calls[startCursor..] re-run (re-park the approval, re-execute). A pending approval
  // pins startCursor to that call's index (it is calls[callCursor] — the loop runs calls in order and
  // every prior call resolved before parking), robust even if the recorded cursor drifted.
  private reconstructForResume(state: ResumeState): { toolCalls: ToolCall[]; startCursor: number } {
    const msgs = this.o.session.messages as any[];
    let ai = -1;
    for (let k = msgs.length - 1; k >= 0; k--) {
      const m = msgs[k];
      if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        ai = k;
        break;
      }
    }
    if (ai < 0) return { toolCalls: [], startCursor: 0 }; // nothing to resume (corrupt/settled snapshot)
    const calls: ToolCall[] = (msgs[ai].tool_calls as any[]).map((c) => ({
      id: c.id,
      type: "function",
      function: {
        name: c.function?.name ?? "",
        arguments:
          typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
      },
    }));
    let startCursor = Math.min(Math.max(0, state.callCursor | 0), calls.length);
    if (state.pendingCallId) {
      const idx = calls.findIndex((c) => c.id === state.pendingCallId);
      if (idx >= 0) startCursor = idx;
    }
    // Everything up to and including the in-flight assistant message, plus the REAL tool results for
    // the already-resolved calls (calls[0..startCursor-1]) — matched by call id, NOT by position. The
    // snapshot is backfillToolResults()'d, which inserts each "interrupted" PLACEHOLDER right after the
    // assistant message (before real results that appeared later in the array), so a positional slice
    // would keep a placeholder and drop a real result → strand the call. Keeping by id drops every
    // placeholder (their calls are >= startCursor, not in the keep set) so calls[startCursor..] re-run.
    const head = msgs.slice(0, ai + 1);
    const keepIds = new Set(calls.slice(0, startCursor).map((c) => c.id));
    const keptResults = msgs.slice(ai + 1).filter((m) => m?.role === "tool" && keepIds.has((m as any).tool_call_id));
    this.o.session.loadMessages([...head, ...keptResults] as any);
    return { toolCalls: calls, startCursor };
  }

  // The main iteration loop: one model completion, then its tool calls, repeated until a terminal
  // exit or MAX_ITERATIONS. Shared by a fresh turn (sendTurn, from iteration 0) and a resumed turn
  // (resumeTurn, from the interrupted iteration + 1).
  private async runLoop(startIteration: number, callCounts: Map<string, number>, signal: AbortSignal): Promise<string> {
    for (let i = startIteration; i < MAX_ITERATIONS; i++) {
      await this.emit({ type: "turn.started", index: i, maxIterations: MAX_ITERATIONS });
      const step = await this.completeOnce(signal);
      if (step.kind === "terminal") return step.text;
      // Mid-turn checkpoint: the assistant tool_calls message is committed and we're about to run
      // tools — persist a 400-safe snapshot (placeholders for the not-yet-run calls) so a crash here
      // leaves the run resumable. No-op unless a host injected `checkpoint`.
      this.saveCheckpoint("executing_tools", i, 0, null, callCounts);
      const exec = await this.executeTools(step.toolCalls, i, callCounts, signal, 0);
      if (exec.kind === "terminal") return exec.text;
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

  // Changes recap for a completed run (drives the Summary recap + Undo-all). EXCLUDE entries already
  // undone in an earlier completion of this same run — the journal is cumulative, so without this
  // filter an "Undo all N" from turn 1 would reappear next turn and re-run its inverses (e.g.
  // re-deleting a folder the user re-created after undoing).
  private currentChanges() {
    return this.o.session.journal
      .list()
      .filter((e) => !e.undone)
      .map((e) => ({
        summary: e.description,
        reversibility: e.reversibility,
        undoable: typeof e.inverse === "function",
        journaledOpId: e.id,
      }));
  }

  // One model completion → push the assistant message → handle every terminal finish reason (its
  // event is emitted here). Returns the tool_calls to execute, or a terminal result to return up.
  private async completeOnce(signal: AbortSignal): Promise<CompleteResult> {
    // Get the completion. STREAMED (cloud default): emit the visible reply token-by-token
    // (message.delta) so the Run View feels alive; tool_call deltas arrive piecemeal (by index)
    // and are reassembled. NON-STREAMED (small local models do tool-calling far better this way):
    // one response, no deltas. Either way we end up with the same content/toolCalls/reasoning, so
    // the tool-execution logic is identical. Reasoning is logged but NEVER streamed raw.
    let content = "";
    let reasoning = "";
    let refusal = "";
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
    // Bounded retry for a TRANSIENT transport failure that struck before any output this turn.
    let attempt = 0;
    const maxRetries = Number(process.env.MAX_TRANSPORT_RETRIES ?? "2");
    const backoffMs = Number(process.env.RETRY_BACKOFF_MS ?? "500");
    for (;;) {
      try {
        if (this.stream) {
          const stream = await this.client.chat.completions.create(
            { ...baseArgs, stream: true, stream_options: { include_usage: true } },
            { signal },
          );
          // Consume with an idle watchdog: the SDK timeout only covers up to the FIRST byte, so a
          // stream that connects then goes silent mid-token would otherwise block forever and leave
          // the run stuck "working". Race each chunk against STREAM_IDLE_MS; on idle, tear down the
          // request and throw into the catch below → a recoverable transport error, not a hang.
          const idleMs = Number(process.env.STREAM_IDLE_MS) || 60_000;
          const iter = (stream as any)[Symbol.asyncIterator]();
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let step: IteratorResult<any>;
            try {
              step = await Promise.race([
                iter.next(),
                new Promise<never>((_, rej) => {
                  timer = setTimeout(() => rej(new Error("stream_idle")), idleMs);
                }),
              ]);
            } catch (e) {
              try {
                (stream as any).controller?.abort?.();
              } catch {
                /* best effort */
              }
              try {
                await iter.return?.();
              } catch {
                /* best effort */
              }
              throw e;
            } finally {
              clearTimeout(timer);
            }
            if (step.done) break;
            const chunk = step.value;
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
            if (typeof delta?.refusal === "string" && delta.refusal) refusal += delta.refusal;
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
          reasoning =
            typeof m.reasoning === "string" ? m.reasoning : typeof m.reasoning_content === "string" ? m.reasoning_content : "";
          refusal = typeof m.refusal === "string" ? m.refusal : "";
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
        break; // create + consume succeeded — leave the retry loop
      } catch (err: any) {
        if (signal.aborted || err?.name === "AbortError") {
          await this.emit({ type: "run.error", kind: "cancelled", userMessage: "Okay, I stopped.", recoverable: true });
          return { kind: "terminal", text: "" };
        }
        this.o.logger.log("transport_error", String(err?.stack ?? err));
        // Retry ONLY a TRANSIENT failure that struck BEFORE any token/tool was emitted this turn —
        // retrying after output would duplicate it, and retrying a deterministic 4xx (bad model id,
        // bad key, malformed request) just wastes round-trips. A connection error / idle-watchdog
        // throw carries no status (→ retry); a 408/409/429/5xx is retryable; a 4xx is not.
        const status = (err as any)?.status;
        const retryable =
          status === undefined || status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500);
        if (attempt < maxRetries && retryable && content === "" && toolAcc.length === 0) {
          attempt++;
          await this.emit({ type: "thinking.summary", summary: "Reconnecting…" });
          // Abortable backoff: if the user hits Stop during the wait, react immediately rather than
          // waiting the timer out and only then noticing on the next create().
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(t);
              signal.removeEventListener("abort", done);
              resolve();
            };
            const t = setTimeout(done, backoffMs * attempt + Math.floor(Math.random() * backoffMs));
            if (signal.aborted) return done();
            signal.addEventListener("abort", done, { once: true });
          });
          if (signal.aborted) {
            await this.emit({ type: "run.error", kind: "cancelled", userMessage: "Okay, I stopped.", recoverable: true });
            return { kind: "terminal", text: "" };
          }
          reasoning = "";
          refusal = "";
          finishReason = null;
          usage = null;
          continue; // try the request again
        }
        await this.emit({
          type: "run.error",
          kind: "transport",
          userMessage: "I had trouble connecting just now. Want to try again?",
          recoverable: true,
        });
        return { kind: "terminal", text: "" };
      }
    } // end retry loop

    const toolCalls = toolAcc.filter(Boolean);
    const msg = {
      role: "assistant" as const,
      content: content || refusal || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    this.o.session.pushAssistant(msg as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    if (usage) this.o.logger.log("usage", usage);

    // If we abandon this turn while tool_calls are already committed to the session (the length /
    // content_filter early returns below), EVERY call must still get a tool result — otherwise
    // session.messages strands an assistant tool_calls message with no matching tool reply and 400s
    // on the next turn (live or rehydrated). Mirrors the post-execution `finally` backfill + the
    // rehydrate placeholder. No-op when there are no tool_calls.
    const backfillStrandedCalls = () => {
      for (const call of toolCalls) {
        this.o.session.pushToolResult(call.id, toToolMessage({ ok: false, error: "interrupted" }));
      }
    };

    // Never surface raw chain-of-thought — log it, emit a safe summary only.
    if (reasoning.trim()) {
      this.o.logger.log("reasoning", reasoning);
      await this.emit({ type: "thinking.summary", summary: "Worked out the next step." });
    }

    if (finishReason === "length") {
      backfillStrandedCalls(); // keep session.messages 400-safe if cut off mid-tool_calls
      await this.emit({
        type: "run.error",
        kind: "length",
        userMessage: "That turned out bigger than expected, so I stopped — nothing was changed.",
        recoverable: false,
      });
      return { kind: "terminal", text: content };
    }
    if (finishReason === "content_filter") {
      backfillStrandedCalls(); // keep session.messages 400-safe if filtered mid-tool_calls
      await this.emit({ type: "run.error", kind: "content_filter", userMessage: "I can't help with that part.", recoverable: false });
      return { kind: "terminal", text: content };
    }

    // The model declined (streamed delta.refusal, or a non-streamed message.refusal). Emit the
    // refusal so the Run View resolves the Thinking pulse with the decline text, then finish the
    // run with that text as the final message — NOT a "completed" empty finalMessage that would
    // render as a blank reply. Backfill any tool_calls the (rare) refusal rode alongside first.
    if (refusal.trim()) {
      backfillStrandedCalls();
      await this.emit({ type: "message.refusal", text: refusal });
      await this.emit({ type: "run.finished", status: "completed", finalMessage: refusal, changes: this.currentChanges() });
      return { kind: "terminal", text: refusal };
    }

    if (toolCalls.length === 0) {
      const text = content;
      if (text) await this.emit({ type: "message.completed", text });
      await this.emit({ type: "run.finished", status: "completed", finalMessage: text, changes: this.currentChanges() });
      return { kind: "terminal", text };
    }

    return { kind: "tools", toolCalls };
  }

  // Execute a turn's tool calls sequentially, starting at `startCursor` (0 for a fresh turn; the
  // pending/resolved boundary for a resume). EVERY call MUST get a tool result appended (ordering
  // invariant) — the `finally` backfills any call left unresolved (cancel, throw, a denied gate) so
  // session.messages never strands a tool_call and 400s next turn. Returns a terminal result
  // (stuck/cancelled) or "continue".
  private async executeTools(
    toolCalls: ToolCall[],
    i: number,
    callCounts: Map<string, number>,
    signal: AbortSignal,
    startCursor: number,
    inflight: Set<string> = new Set(),
  ): Promise<ExecResult> {
    // The most recent screenshot a tool streamed THIS step — fed to a vision model so it can see
    // the page (set in onScreenshot, consumed + cleared after each tool result).
    let lastShot: string | null = null;
    const ctx: ToolContext = {
      signal,
      journal: this.o.session.journal,
      runId: this.runId,
      workspaceRoot: this.workspaceRoot,
      roots: this.roots,
      onScreenshot: (dataUrl) => {
        lastShot = dataUrl;
        void this.emit({ type: "screenshot", dataUrl });
      },
    };
    const resolvedCalls = new Set<string>();
    let cancelled = false;
    const pushResult = (callId: string, content: string) => {
      this.o.session.pushToolResult(callId, content);
      resolvedCalls.add(callId);
      // NB: deliberately NOT re-checkpointing per tool result — that re-serialized the whole
      // (possibly screenshot/doc-laden) conversation synchronously on every result, O(K·N) per
      // turn on the event loop. The after-assistant checkpoint + the pre-approval one bound the
      // lost-work window; a crash mid-execution just re-runs this iteration's tools on resume
      // (reversible → idempotent; the pre-approval snapshot re-parks a gated call before it ran).
    };
    // On resume, calls[0..startCursor-1] already ran and their REAL results are already in
    // session.messages (reconstructForResume kept them) — mark them resolved so the finally-backfill
    // leaves them alone and the loop below doesn't re-execute them.
    for (let k = 0; k < startCursor && k < toolCalls.length; k++) resolvedCalls.add(toolCalls[k].id);

    try {
      for (let k = startCursor; k < toolCalls.length; k++) {
        const call = toolCalls[k];
        if (cancelled) break;
        const callId = call.id;
        // Crash-consistency guard for IRREVERSIBLE actions: if this call was mid-execution when the
        // process died (a tool_inflight marker survived into this resume), do NOT re-run it — a
        // permanent action (send email, pay) could double-execute. Mark it UNCERTAIN and move on so the
        // model asks the user to verify rather than blindly repeating. Only ever set for resumed runs.
        if (inflight.has(callId)) {
          await this.emit({
            type: "tool.result",
            callId,
            ok: false,
            summary: "I'm not certain that finished — please check before trying it again.",
          });
          pushResult(
            callId,
            toToolMessage({
              ok: false,
              outcome: "uncertain",
              summary: "UNCERTAIN: this may or may not have completed before an interruption. Do NOT repeat it; ask the user to verify.",
            }),
          );
          this.o.clearInflight?.(callId);
          continue;
        }
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
          const auto = description.reversibility === "reversible" && this.gate.autoApproves?.(reqInfo) === true;
          if (auto) {
            await this.emit({ type: "approval.resolved", callId, decision: "approved" });
          } else {
            await this.emit({ type: "approval.required", ...reqInfo });
            // Checkpoint the suspension point: which call is awaiting approval, so resume re-parks it
            // (re-emits approval.required + re-registers the gate promise) rather than lose it on a crash.
            this.saveCheckpoint("awaiting_approval", i, resolvedCalls.size, callId, callCounts);
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
        // Persist an in-flight marker RIGHT BEFORE running an irreversible tool (no async yield between
        // this and tool.run), so a hard kill mid-run is detected on resume (the guard at the loop top).
        // Reversible tools skip this — re-running them is safe/idempotent, so no marker is needed.
        if (permanent) this.o.markInflight?.(callId, tool.name, description.reversibility);
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
                  summary: "UNCERTAIN: this may or may not have completed. Do NOT repeat it; ask the user to verify.",
                }
              : result,
          ),
        );
        // The tool has settled and its result is durable — drop the in-flight marker (no-op for
        // reversible tools, which were never marked). A crash before here leaves the marker for resume.
        if (permanent) this.o.clearInflight?.(callId);

        // Stuck-detection (post-run, not at prepare-time). Count EVERY executed call with a
        // byte-identical (tool, args) signature — success OR failure. The most common real
        // stuck mode is an action that SUCCEEDS every time but changes nothing (clicking a
        // no-op/disabled button returns ok with a readable page; re-typing the same text;
        // re-writing identical content), so resetting on success would let it burn all the way
        // to MAX_ITERATIONS. Denied/expired/cancelled approvals and preflight failures `continue`
        // above and never reach here (so the user pushing back can't trip it); uncertain
        // permanent actions are excluded (we already tell the model not to retry them). Distinct
        // args — e.g. writing several DIFFERENT files — have distinct signatures and never collide.
        if (!REPEATABLE.has(tool.name) && !uncertain) {
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
            return { kind: "terminal", text: "" };
          }
        }
      }
    } finally {
      // INVARIANT: backfill any tool_call left without a result.
      for (const call of toolCalls) {
        if (!resolvedCalls.has(call.id)) {
          pushResult(call.id, toToolMessage({ ok: false, error: "unresolved" }));
        }
      }
    }

    // Give the model EYES: once ALL of this turn's tool results are in (so the assistant→tool
    // ordering invariant holds), hand a vision model ONE image of the page — the most recent
    // browser screenshot this turn — so its next decision is informed by what it can actually SEE,
    // not just the text element-list. The session prunes older screenshots to a placeholder.
    if (this.vision && lastShot && !cancelled) {
      this.o.session.pushUserImage(
        "This is what the page looks like now. Use it together with the numbered elements above to choose your next step.",
        lastShot,
      );
    }

    if (cancelled) {
      await this.emit({ type: "run.error", kind: "cancelled", userMessage: "Okay, I stopped.", recoverable: true });
      return { kind: "terminal", text: "" };
    }
    return { kind: "continue" };
  }
}
