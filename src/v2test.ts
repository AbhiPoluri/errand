// v2 integration tests — the parts most likely to be subtly wrong:
//   A. the journal actually reverses a recorded op (and skips non-reversible ones)
//   B. THE INVARIANT: park on a gated approval -> cancel -> start a NEW turn in the
//      same Session -> the next real API request does NOT 400 (no stranded tool_call)
//   C. a denied approval lets the run continue (model sees the refusal, replies)
import { writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";
import { config } from "./config.ts";
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Journal } from "./journal.ts";
import { Registry } from "./tools/index.ts";
import { getDate } from "./tools/getDate.ts";
import { bash } from "./tools/bash.ts";
import { AgentRunner } from "./loop.ts";
import { ScriptedApprovalGate } from "./approvals.ts";
import type { AgentEvent, EventSink } from "./events.ts";
import { wellFormed } from "./testutil.ts";

const SYSTEM =
  "You are Errand, a calm helper. Keep replies short and plain. Never use emojis. Use tools when asked.";

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

async function testJournal() {
  console.log("\n== A. journal reversibility ==");
  const dir = join(config.workspaceRoot, "__journaltest");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "marker.txt");
  writeFileSync(f, "hi");

  const j = new Journal();
  j.record({
    op: "write",
    description: "Created marker.txt",
    reversibility: "reversible",
    inverse: async () => rmSync(f, { force: true }),
  });
  j.record({ op: "run_command", description: "Ran a command", reversibility: "unknown" }); // no inverse

  check("file exists before undo", existsSync(f));
  check("reversibleCount = 1 (non-reversible skipped)", j.reversibleCount() === 1);
  const res = await j.undoAll();
  check("undoAll reversed 1, skipped 1", res.undone === 1 && res.skipped === 1, JSON.stringify(res));
  check("file removed after undo", !existsSync(f));
  rmSync(dir, { recursive: true, force: true });
}

async function testCancelInvariant() {
  console.log("\n== B. approval pause -> cancel -> new turn does not 400 ==");
  const runId = crypto.randomUUID();
  const session = new Session(SYSTEM);
  const tap = new Tap();
  const runner = new AgentRunner({
    session,
    sink: tap,
    registry: new Registry().register(bash).register(getDate),
    model: config.model,
    logger: new Logger(runId),
    runId,
    gate: new ScriptedApprovalGate(["cancelled"]), // user cancels at the approval
  });

  await runner.send(
    "Please run the shell command: echo hello — use your run_command tool to do it.",
    new AbortController().signal,
  );

  const approvalFired = tap.events.some((e) => e.type === "approval.required");
  const cancelled = tap.events.some((e) => e.type === "run.error" && e.kind === "cancelled");
  const wf = wellFormed(session.messages as Msg[]);
  check("approval.required was emitted (gate exercised)", approvalFired);
  check("run ended as cancelled", cancelled);
  check("session.messages well-formed after cancel", wf.ok, wf.detail);

  // The real test: a brand-new turn in the SAME session must not 400.
  const before = tap.events.length;
  const reply = await runner.send("Reply with the single word: ready", new AbortController().signal);
  const transportErr = tap.events
    .slice(before)
    .find((e) => e.type === "run.error" && e.kind === "transport");
  check("new turn after cancel succeeded (no 400)", !transportErr && reply.length > 0, `reply="${reply}"`);
}

async function testDeniedContinues() {
  console.log("\n== C. denied approval lets the run continue ==");
  const runId = crypto.randomUUID();
  const session = new Session(SYSTEM);
  const tap = new Tap();
  const runner = new AgentRunner({
    session,
    sink: tap,
    registry: new Registry().register(bash).register(getDate),
    model: config.model,
    logger: new Logger(runId),
    runId,
    gate: new ScriptedApprovalGate(["denied"]),
  });

  await runner.send(
    "Run the shell command: echo hi (use run_command). If you can't, just say so briefly.",
    new AbortController().signal,
  );
  const denied = tap.events.some((e) => e.type === "approval.resolved" && e.decision === "denied");
  const finished = tap.events.some((e) => e.type === "run.finished");
  const wf = wellFormed(session.messages as Msg[]);
  check("approval was denied", denied);
  check("run still finished (model continued)", finished);
  check("session.messages well-formed after denial", wf.ok, wf.detail);
}

async function main() {
  await testJournal();
  await testCancelInvariant();
  await testDeniedContinues();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
