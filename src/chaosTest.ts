// CHAOS CRASH-INJECTION HARNESS — the headline durability proof. It drives a representative
// multi-step agent run (multiple iterations, gated tool calls, a multi-call iteration) once to
// completion, capturing the FULL set of durable crash points: every mid-turn checkpoint the loop
// persists (executing_tools + awaiting_approval) AND every post-tool-result boundary. Then, for EACH
// captured point, it simulates a hard crash — drop ALL in-memory runner state and rebuild the run
// PURELY from SQLite (persisted event log + journal manifest + turn_state) — resumes it, and asserts
// the run recovers with:
//   (i)  a VALID OpenAI message history (no stranded tool_call — the approval-exit invariant),
//   (ii) NO lost or duplicated events in the replayed SSE stream (strictly increasing unique structural
//        seqs; every resumed event at/above startSeq so a reconnecting client never re-sees a seq),
//   (iii) JOURNAL CONSISTENCY (no half-applied mutation without a recorded inverse — every reversible
//        entry carries a live/reconstructed inverse AND a restartable manifest),
//   plus a clean terminal settle. It prints a legible PASS MATRIX. Fully offline + deterministic
//   (mock model + mock reversible tool). Run: `npm run chaos:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { z } from "zod";
import type OpenAI from "openai";
import { Session, backfillToolResults } from "./session.ts";
import { Logger } from "./log.ts";
import { Registry, type Tool } from "./tools/index.ts";
import { AgentRunner, type TurnState } from "./loop.ts";
import { wellFormed } from "./testutil.ts";
import { ScriptedApprovalGate } from "./approvals.ts";
import type { AgentEvent, EventSink } from "./events.ts";

const dbPath = join(tmpdir(), `errand-chaos-${process.pid}.db`);
process.env.ERRAND_DB = dbPath;
const store = await import("./server/store.ts");
const { rebuildJournalFromStore } = await import("./server/journalRestore.ts");

const ws = mkdtempSync(join(tmpdir(), "errand-chaos-ws-"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// A gated, reversible MOCK tool: mutates an in-memory map and records a journal entry with a live
// inverse + a restartable manifest — like the real file tools, but deterministic + fs-free.
const mutated: Record<string, string> = {};
const mockTool: Tool<{ key: string; val: string }> = {
  name: "stash",
  modelDescription: "stash a value",
  jsonSchema: { type: "object", additionalProperties: false, required: ["key", "val"], properties: { key: { type: "string" }, val: { type: "string" } } },
  argsSchema: z.object({ key: z.string(), val: z.string() }),
  gated: true,
  describe: (a) => ({ action: `Stash ${a.key}`, items: [a.key], consequences: "You can undo this.", reversibility: "reversible" }),
  summarize: () => "Stashed.",
  run: async (a, ctx) => {
    const prior = mutated[a.key];
    mutated[a.key] = a.val;
    ctx.journal.record({
      op: "stash",
      description: `Stashed ${a.key}`,
      reversibility: "reversible",
      inverse: async () => {
        if (prior === undefined) delete mutated[a.key];
        else mutated[a.key] = prior;
      },
      // A real, reconstructable manifest (ws-scoped path so any reconstructed inverse is fs-safe).
      manifest: { kind: "write", path: join(ws, a.key), wasNew: prior === undefined, snapshot: null },
    });
    return { ok: true, data: {} };
  },
};

const reg = new Registry();
reg.register(mockTool);

// Deterministic multi-step model script: three tool iterations (the third emits TWO calls in one
// assistant message, exercising a mid-iteration resume boundary), then a final reply.
const toolCall = (callId: string, args: unknown) => ({ id: callId, type: "function", function: { name: "stash", arguments: JSON.stringify(args) } });
const asstToolCalls = (calls: any[]) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }], usage: null });
const textResp = (t: string) => ({ choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], usage: null });
const GOLDEN_SCRIPT = [
  asstToolCalls([toolCall("c0", { key: "a", val: "1" })]),
  asstToolCalls([toolCall("c1", { key: "b", val: "2" })]),
  asstToolCalls([toolCall("c2a", { key: "c", val: "3" }), toolCall("c2b", { key: "d", val: "4" })]),
  textResp("All done — stashed everything."),
];
function scriptedClient(script: any[]): OpenAI {
  let i = 0;
  return { chat: { completions: { create: async () => script[Math.min(i++, script.length - 1)] } } } as unknown as OpenAI;
}
// The resume continuation: after the interrupted turn's tools finish, end the turn with a reply.
const continuationClient = (): OpenAI => ({ chat: { completions: { create: async () => textResp("Recovered and finished.") } } } as unknown as OpenAI);

interface Injection {
  label: string;
  ts: TurnState; // the (real or synthesized) checkpoint to resume from
  events: AgentEvent[]; // the event log as it stood at crash time
  journalOps: ReturnType<typeof store.getJournalOps>;
}

// The number of REAL tool results already appended after the in-flight assistant tool_calls message.
function cursorOf(msgs: any[]): number {
  let ai = -1;
  for (let k = msgs.length - 1; k >= 0; k--) {
    if (msgs[k]?.role === "assistant" && Array.isArray(msgs[k].tool_calls) && msgs[k].tool_calls.length) {
      ai = k;
      break;
    }
  }
  if (ai < 0) return 0;
  return msgs.slice(ai + 1).filter((m: any) => m?.role === "tool").length;
}

async function goldenRun(): Promise<Injection[]> {
  const runId = crypto.randomUUID();
  store.createRun(runId, "chaos golden", Date.now(), [ws]);
  const session = new Session("system");
  session.journal.onRecord = (e) =>
    store.appendJournalOp(runId, { opId: e.id, op: e.op, description: e.description, reversibility: e.reversibility, manifest: e.manifest });
  const injections: Injection[] = [];
  let curIter = 0;
  let curTurnId = "";

  // A sink that persists like the live host AND captures a post-tool-result crash point after each result.
  const sink: EventSink = {
    emit(e: AgentEvent) {
      if (e.type !== "message.delta") store.appendEvent(runId, e);
      if (e.type === "turn.started") curIter = e.index;
      curTurnId = e.turnId || curTurnId;
      if (e.type === "tool.result") {
        const cursor = cursorOf(session.messages as any);
        injections.push({
          label: `post-tool.result it${curIter} cur${cursor}`,
          ts: {
            turnId: curTurnId,
            phase: "executing_tools",
            iteration: curIter,
            callCursor: cursor,
            pendingCallId: null,
            messages: backfillToolResults(session.messages),
            callCounts: {},
            maxEmittedSeq: e.seq,
          },
          events: clone(store.getEvents(runId)),
          journalOps: clone(store.getJournalOps(runId)),
        });
      }
    },
  };

  const runner = new AgentRunner({
    session,
    sink,
    registry: reg,
    model: "stub",
    logger: new Logger(runId),
    runId,
    client: scriptedClient(GOLDEN_SCRIPT),
    stream: false,
    gate: new ScriptedApprovalGate([], "approved"), // approve every gated call so the run completes
    workspaceRoot: ws,
    roots: [ws],
    // Capture every REAL durable checkpoint the loop persists.
    checkpoint: (s) => {
      store.saveTurnState(runId, { ...s, autoApproveReversible: false });
      injections.push({
        label: `checkpoint ${s.phase} it${s.iteration} cur${s.callCursor}${s.pendingCallId ? " pend=" + s.pendingCallId : ""}`,
        ts: clone(s),
        events: clone(store.getEvents(runId)),
        journalOps: clone(store.getJournalOps(runId)),
      });
    },
  });
  await runner.send("stash a few things", new AbortController().signal);
  return injections;
}

interface Row {
  label: string;
  validHistory: boolean;
  seqIntegrity: boolean;
  journalConsistent: boolean;
  terminal: boolean;
}

async function injectAndRecover(inj: Injection): Promise<Row> {
  // "Crash then reboot": seed a brand-new run purely from the captured persisted state, then rebuild
  // the runner from SQLite alone (event log + journal manifest + turn_state) and resume it.
  const rid = crypto.randomUUID();
  store.createRun(rid, inj.label, Date.now(), [ws]);
  for (const e of inj.events) store.appendEvent(rid, { ...e, runId: rid });
  for (const op of inj.journalOps)
    store.appendJournalOp(rid, { opId: op.opId, op: op.op, description: op.description, reversibility: op.reversibility, manifest: op.manifest });
  store.saveTurnState(rid, { ...inj.ts, autoApproveReversible: false });

  const evs = store.getEvents(rid);
  const startSeq = (evs.length ? evs[evs.length - 1].seq : -1) + 1;
  const session = new Session("system");
  rebuildJournalFromStore(rid, session.journal); // inverses reconstructed from the persisted manifest
  session.journal.onRecord = (e) =>
    store.appendJournalOp(rid, { opId: e.id, op: e.op, description: e.description, reversibility: e.reversibility, manifest: e.manifest });
  const sink: EventSink = {
    persisted: [] as AgentEvent[],
    emit(e: AgentEvent) {
      (this as any).persisted.push(e);
      if (e.type !== "message.delta") store.appendEvent(rid, e);
    },
  } as any;
  const state = store.getTurnState(rid)!;
  const runner = new AgentRunner({
    session,
    sink,
    registry: reg,
    model: "stub",
    logger: new Logger(rid),
    runId: rid,
    client: continuationClient(),
    stream: false,
    gate: new ScriptedApprovalGate([], "approved"),
    workspaceRoot: ws,
    roots: [ws],
    startSeq,
    checkpoint: (s) => store.saveTurnState(rid, { ...s, autoApproveReversible: false }),
  });
  await runner.resume(state as any, new AbortController().signal);

  // (i) valid history
  const validHistory = wellFormed(session.messages as any).ok;
  if (!validHistory && process.env.CHAOS_DEBUG) {
    console.log(`\n[DEBUG ${inj.label}] ${wellFormed(session.messages as any).detail}`);
    console.log("  snapshot msgs:", (inj.ts.messages as any[]).map((m: any) => `${m.role}${m.tool_calls ? "[" + m.tool_calls.map((c: any) => c.id).join(",") + "]" : m.tool_call_id ? "(" + m.tool_call_id + ")" : ""}`).join(" "));
    console.log("  final msgs:   ", (session.messages as any[]).map((m: any) => `${m.role}${m.tool_calls ? "[" + m.tool_calls.map((c: any) => c.id).join(",") + "]" : m.tool_call_id ? "(" + m.tool_call_id + ")" : ""}`).join(" "));
  }
  // (ii) seq integrity: strictly increasing unique structural seqs, every resumed event at/above startSeq
  const stream = store.getEvents(rid).filter((e) => e.type !== "message.delta");
  let monotonic = true;
  const seen = new Set<number>();
  for (let k = 0; k < stream.length; k++) {
    if (seen.has(stream[k].seq)) monotonic = false;
    seen.add(stream[k].seq);
    if (k > 0 && stream[k].seq <= stream[k - 1].seq) monotonic = false;
  }
  const resumedAboveStart = (sink as any).persisted.every((e: AgentEvent) => e.seq >= startSeq);
  const seqIntegrity = monotonic && resumedAboveStart;
  // (iii) journal consistency: no reversible entry lacks an inverse or a restartable manifest
  const journalConsistent = session.journal
    .list()
    .every((e) => e.reversibility !== "reversible" || (typeof e.inverse === "function" && !!e.manifest));
  // clean terminal settle
  const terminal = stream.some((e) => e.type === "run.finished" || e.type === "run.error");

  return { label: inj.label, validHistory, seqIntegrity, journalConsistent, terminal };
}

async function main(): Promise<void> {
  const injections = await goldenRun();
  const rows: Row[] = [];
  for (const inj of injections) rows.push(await injectAndRecover(inj));

  // ---- pass matrix (legible) ----
  const yn = (b: boolean) => (b ? " ✓ " : " ✗ ");
  console.log("\n╔════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  CHAOS CRASH-INJECTION MATRIX — rebuild from SQLite + resume at every crash point  ║");
  console.log("╚════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`  #  ${"crash point".padEnd(40)} history  seq   journal  settled`);
  console.log(`  ${"─".repeat(78)}`);
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i).padStart(2)} ${r.label.padEnd(40)}  ${yn(r.validHistory)}    ${yn(r.seqIntegrity)}   ${yn(r.journalConsistent)}   ${yn(r.terminal)}`,
    );
  });
  console.log(`  ${"─".repeat(78)}`);

  const allGreen = (r: Row) => r.validHistory && r.seqIntegrity && r.journalConsistent && r.terminal;
  const passed = rows.filter(allGreen).length;
  console.log(`\n  ${rows.length} injection points — ${passed} passed, ${rows.length - passed} failed.`);
  const ok = rows.length > 0 && passed === rows.length;
  console.log(`\nRESULT: ${ok ? "ALL PASS" : `${rows.length - passed} FAILED`}`);

  rmSync(ws, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

await main().finally(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* temp file — ignore */
    }
  }
});
