// Loop safety-rail tests — fully OFFLINE, driven by a stub OpenAI client injected via
// RunnerOpts.client (stream:false for simplicity). No network, no live model, deterministic.
//
// These lock the central loop's behavior that a live-model test can't pin down:
//   1. stuck-detection counts only CONSECUTIVE genuine FAILURES of the same action
//   2. a repeatedly SUCCEEDING identical call never aborts (success resets the counter)
//   3. repeatedly DENIED approvals never abort (denied calls never run, so never count)
// (rank 15 extends this file with finish_reason and malformed-tool_call cases.)
import { z } from "zod";
import type OpenAI from "openai";
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Registry, type Tool, type ToolResult, type Reversibility } from "./tools/index.ts";
import { AgentRunner } from "./loop.ts";
import { ScriptedApprovalGate } from "./approvals.ts";
import type { AgentEvent, EventSink } from "./events.ts";
import { wellFormed } from "./testutil.ts";

const SYSTEM = "You are Errand, a calm test helper.";
type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

class Tap implements EventSink {
  events: AgentEvent[] = [];
  emit(e: AgentEvent) {
    this.events.push(e);
  }
}

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

// ---- stub building blocks ----
// A scripted non-streamed completion: either a tool call or a final text reply.
function toolCallResp(name: string, args: unknown, callId: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: null,
  };
}
function textResp(text: string) {
  return { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: null };
}
function finishResp(reason: string, text = "") {
  return { choices: [{ message: { role: "assistant", content: text }, finish_reason: reason }], usage: null };
}
// A tool call whose arguments string is passed through verbatim (to script malformed JSON).
function rawToolCallResp(name: string, rawArgs: string, callId: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name, arguments: rawArgs } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: null,
  };
}

// Stub client: create() returns responder(callIndex). Ignores the request args entirely.
function stubClient(responder: (i: number) => any): OpenAI {
  let i = 0;
  return { chat: { completions: { create: async () => responder(i++) } } } as unknown as OpenAI;
}

// A minimal tool with a fixed result, used to script success/failure deterministically.
function stubTool(
  name: string,
  opts: { result: ToolResult; gated?: boolean; reversibility?: Reversibility },
): Tool<{ x?: number }> {
  return {
    name,
    modelDescription: name,
    jsonSchema: { type: "object", properties: { x: { type: "number" } } },
    argsSchema: z.object({ x: z.number().optional() }),
    gated: opts.gated ?? false,
    describe: () => ({ action: name, reversibility: opts.reversibility ?? "reversible" }),
    summarize: (r) => (r.ok ? "Done." : "That step didn't work."),
    run: async () => opts.result,
  };
}

function makeRunner(registry: Registry, responder: (i: number) => any, gate?: ScriptedApprovalGate) {
  const runId = crypto.randomUUID();
  const session = new Session(SYSTEM);
  const tap = new Tap();
  const runner = new AgentRunner({
    session,
    sink: tap,
    registry,
    model: "stub-model",
    logger: new Logger(runId),
    runId,
    client: stubClient(responder),
    stream: false,
    gate,
  });
  return { runner, session, tap };
}

async function testFailingActionAborts() {
  console.log("\n== 1. same non-repeatable action FAILING 6x -> max_iterations ==");
  // A non-repeatable tool that always fails, called with identical args every turn.
  const registry = new Registry().register(stubTool("do_thing", { result: { ok: false, error: "nope" } }));
  const { runner, session, tap } = makeRunner(registry, () => toolCallResp("do_thing", { x: 1 }, crypto.randomUUID()));
  await runner.send("keep trying the thing", new AbortController().signal);

  const aborted = tap.events.some((e) => e.type === "run.error" && e.kind === "max_iterations");
  const finished = tap.events.some((e) => e.type === "run.finished");
  const runs = tap.events.filter((e) => e.type === "tool.started").length;
  const wf = wellFormed(session.messages as Msg[]);
  check("aborted with max_iterations", aborted);
  check("did NOT report a normal finish", !finished);
  check("aborted at the threshold (6 runs, not 300)", runs === 6, `ran ${runs}x`);
  check("messages well-formed after abort", wf.ok, wf.detail);
}

async function testSucceedingActionDoesNotAbort() {
  console.log("\n== 2. same non-repeatable action SUCCEEDING 6x -> finishes, no abort ==");
  // Succeeds 6 times (same args), then the model returns a final reply.
  const registry = new Registry().register(stubTool("do_thing", { result: { ok: true } }));
  const { runner, session, tap } = makeRunner(registry, (i) =>
    i < 6 ? toolCallResp("do_thing", { x: 1 }, crypto.randomUUID()) : textResp("all done"),
  );
  await runner.send("do the idempotent thing repeatedly", new AbortController().signal);

  const aborted = tap.events.some((e) => e.type === "run.error" && e.kind === "max_iterations");
  const finished = tap.events.some((e) => e.type === "run.finished");
  const wf = wellFormed(session.messages as Msg[]);
  check("did NOT abort (success resets the counter)", !aborted);
  check("run finished normally", finished);
  check("messages well-formed", wf.ok, wf.detail);
}

async function testDeniedApprovalsDoNotAbort() {
  console.log("\n== 3. same gated action DENIED 6x -> finishes, no abort ==");
  // A gated tool proposed 6 times; the gate denies every time. Denied calls never run,
  // so they must never count toward stuck-detection.
  const registry = new Registry().register(stubTool("touch_thing", { result: { ok: true }, gated: true }));
  const { runner, session, tap } = makeRunner(
    registry,
    (i) => (i < 6 ? toolCallResp("touch_thing", { x: 1 }, crypto.randomUUID()) : textResp("left it alone")),
    new ScriptedApprovalGate([], "denied"),
  );
  await runner.send("touch the thing", new AbortController().signal);

  const denials = tap.events.filter((e) => e.type === "approval.resolved" && e.decision === "denied").length;
  const aborted = tap.events.some((e) => e.type === "run.error" && e.kind === "max_iterations");
  const finished = tap.events.some((e) => e.type === "run.finished");
  const wf = wellFormed(session.messages as Msg[]);
  check("all 6 proposals were denied", denials === 6, `${denials} denials`);
  check("did NOT abort (denied calls never count)", !aborted);
  check("run finished normally", finished);
  check("messages well-formed after 6 denials", wf.ok, wf.detail);
}

async function testLengthExit() {
  console.log("\n== 4. finish_reason=length -> run.error kind=length, not recoverable ==");
  const registry = new Registry().register(stubTool("do_thing", { result: { ok: true } }));
  const { runner, tap } = makeRunner(registry, () => finishResp("length", "a partial answer"));
  await runner.send("write something enormous", new AbortController().signal);
  const err = tap.events.find((e) => e.type === "run.error");
  check("run.error has kind=length", err?.type === "run.error" && err.kind === "length");
  check("length is marked NOT recoverable", err?.type === "run.error" && err.recoverable === false);
  check("no normal finish was reported", !tap.events.some((e) => e.type === "run.finished"));
}

async function testContentFilterExit() {
  console.log("\n== 5. finish_reason=content_filter -> run.error kind=content_filter ==");
  const registry = new Registry().register(stubTool("do_thing", { result: { ok: true } }));
  const { runner, tap } = makeRunner(registry, () => finishResp("content_filter"));
  await runner.send("something disallowed", new AbortController().signal);
  const err = tap.events.find((e) => e.type === "run.error");
  check("run.error has kind=content_filter", err?.type === "run.error" && err.kind === "content_filter");
  check("no normal finish was reported", !tap.events.some((e) => e.type === "run.finished"));
}

async function testUnknownToolStaysWellFormed() {
  console.log("\n== 6. unknown tool name -> result still appended, messages well-formed ==");
  const registry = new Registry().register(stubTool("do_thing", { result: { ok: true } }));
  const { runner, session, tap } = makeRunner(registry, (i) =>
    i === 0 ? toolCallResp("no_such_tool", { x: 1 }, crypto.randomUUID()) : textResp("recovered"),
  );
  await runner.send("call a tool that doesn't exist", new AbortController().signal);
  const wf = wellFormed(session.messages as Msg[]);
  check("messages well-formed (the unknown tool_call got a result)", wf.ok, wf.detail);
  check("run recovered and finished", tap.events.some((e) => e.type === "run.finished"));
}

async function testInvalidArgsStaysWellFormed() {
  console.log("\n== 7. invalid JSON tool args -> result still appended, messages well-formed ==");
  const registry = new Registry().register(stubTool("do_thing", { result: { ok: true } }));
  const { runner, session, tap } = makeRunner(registry, (i) =>
    i === 0 ? rawToolCallResp("do_thing", "{not valid json", crypto.randomUUID()) : textResp("recovered"),
  );
  await runner.send("call a tool with broken args", new AbortController().signal);
  const wf = wellFormed(session.messages as Msg[]);
  check("messages well-formed (the invalid-args tool_call got a result)", wf.ok, wf.detail);
  check("run recovered and finished", tap.events.some((e) => e.type === "run.finished"));
}

async function main() {
  await testFailingActionAborts();
  await testSucceedingActionDoesNotAbort();
  await testDeniedApprovalsDoNotAbort();
  await testLengthExit();
  await testContentFilterExit();
  await testUnknownToolStaysWellFormed();
  await testInvalidArgsStaysWellFormed();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
