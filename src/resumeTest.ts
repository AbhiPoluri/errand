// Verifies Phase 3b — incremental mid-turn persistence. Two things:
//   A. The LOOP produces 400-SAFE checkpoints: at every boundary (after the assistant tool_calls
//      message, after each tool result, before an approval) the checkpoint's `messages` array never
//      strands a tool_call — so a resumed run can't 400. The riskiest point is right after the
//      assistant commits its tool_calls but before any tool ran: the snapshot must backfill a
//      placeholder result. This is the core correctness guarantee of resumable runs.
//   B. The STORE round-trips turn_state: saveTurnState -> getTurnState equal -> clearTurnState -> null.
// Fully offline (stub client). Run: `npm run resume:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { z } from "zod";
import type OpenAI from "openai";
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Registry, type Tool } from "./tools/index.ts";
import { AgentRunner, type TurnState } from "./loop.ts";
import { wellFormed } from "./testutil.ts";
import type { AgentEvent, EventSink } from "./events.ts";
import type { TurnStateRow } from "./server/store.ts"; // type-only — erased at runtime, no DB open

const dbPath = join(tmpdir(), `errand-resumetest-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // set BEFORE importing store
const store = await import("./server/store.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

class Tap implements EventSink {
  events: AgentEvent[] = [];
  emit(e: AgentEvent) {
    this.events.push(e);
  }
}

function toolCallResp(name: string, callId: string) {
  return {
    choices: [
      {
        message: { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name, arguments: "{}" } }] },
        finish_reason: "tool_calls",
      },
    ],
    usage: null,
  };
}
const textResp = (text: string) => ({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: null });
function stubClient(responder: (i: number) => any): OpenAI {
  let i = 0;
  return { chat: { completions: { create: async () => responder(i++) } } } as unknown as OpenAI;
}
const stubTool: Tool<{ x?: number }> = {
  name: "do_thing",
  modelDescription: "do a thing",
  jsonSchema: { type: "object", properties: {} },
  argsSchema: z.object({ x: z.number().optional() }),
  gated: false,
  describe: () => ({ action: "Doing a thing", reversibility: "reversible" }),
  summarize: () => "Done.",
  run: async () => ({ ok: true, data: {} }),
};

async function main(): Promise<void> {
  // ---- A. the loop emits only 400-safe checkpoints ----
  const reg = new Registry();
  reg.register(stubTool);
  const session = new Session("system");
  const tap = new Tap();
  const captured: TurnState[] = [];
  const runId = crypto.randomUUID();
  const runner = new AgentRunner({
    session,
    sink: tap,
    registry: reg,
    model: "stub",
    logger: new Logger(runId),
    runId,
    client: stubClient((i) => (i === 0 ? toolCallResp("do_thing", "call-1") : textResp("all done"))),
    stream: false,
    checkpoint: (s) => captured.push(JSON.parse(JSON.stringify(s))), // deep-copy: messages mutate after
  });
  await runner.send("do the thing", new AbortController().signal);

  check("the loop produced a checkpoint", captured.length >= 1, `${captured.length} captured`);
  check("EVERY checkpoint's messages is 400-safe (no stranded tool_call)", captured.every((c) => wellFormed(c.messages as any).ok));

  // The checkpoint after the assistant tool_calls message (before the tool ran) is the riskiest:
  // its messages MUST carry a backfilled placeholder result so it's 400-safe. (Per-result
  // checkpoints were intentionally dropped — too costly — so cursor stays 0 here.)
  const atAssistant = captured.find((c) => c.phase === "executing_tools" && c.callCursor === 0);
  check("checkpoint exists at executing_tools / cursor 0 (assistant committed, tool not run)", !!atAssistant);
  if (atAssistant) {
    const lastTool = [...(atAssistant.messages as any[])].reverse().find((m) => m.role === "tool");
    check("...and it backfilled a placeholder result for the not-yet-run call", typeof lastTool?.content === "string" && lastTool.content.includes("interrupted"));
    check("...and that snapshot is 400-safe", wellFormed(atAssistant.messages as any).ok);
  }
  check("checkpoints carry loop position (turnId + a numeric maxEmittedSeq)", captured.every((c) => !!c.turnId && typeof c.maxEmittedSeq === "number"));

  // ---- B. store round-trip ----
  const sample: TurnStateRow = {
    turnId: "t1",
    phase: "awaiting_approval",
    iteration: 3,
    callCursor: 2,
    pendingCallId: "call-9",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
    callCounts: { "browser_click:x": 4 },
    autoApproveReversible: true,
    maxEmittedSeq: 17,
  };
  store.createRun("r1", "resume round-trip", 1, ["/tmp"]);
  store.saveTurnState("r1", sample);
  const got = store.getTurnState("r1");
  check("getTurnState round-trips the saved state", JSON.stringify(got) === JSON.stringify(sample), JSON.stringify(got));
  // INSERT OR REPLACE: one row per run.
  store.saveTurnState("r1", { ...sample, iteration: 9 });
  check("saving again replaces (one in-flight turn per run)", store.getTurnState("r1")?.iteration === 9);
  store.clearTurnState("r1");
  check("clearTurnState removes it", store.getTurnState("r1") === null);

  // The shape the loop writes most often: executing_tools, no pending call, counters present/empty.
  const noPending: TurnStateRow = {
    turnId: "t2", phase: "executing_tools", iteration: 0, callCursor: 0, pendingCallId: null,
    messages: [], callCounts: {}, autoApproveReversible: false, maxEmittedSeq: -1,
  };
  store.createRun("r2", "no-pending", 1, ["/tmp"]);
  store.saveTurnState("r2", noPending);
  const g2 = store.getTurnState("r2");
  check("null pendingCallId + empty callCounts round-trip cleanly", g2?.pendingCallId === null && JSON.stringify(g2?.callCounts) === "{}");

  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
