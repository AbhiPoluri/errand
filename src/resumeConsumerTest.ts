// The RESUME CONSUMER, end-to-end and fully offline (stub model, real writeFile tool, real SQLite via
// ERRAND_DB). This is the flagship durability proof at the AgentRunner level: a run driven to a
// PERSISTED PRE-APPROVAL checkpoint, then "restarted" (all in-memory runner state dropped and rebuilt
// purely from turn_state + the persisted event log), resumes into a running loop that:
//   1. re-parks the pending approval so a /decision-style resolve still drives it,
//   2. on approval, actually RUNS the mutation (the tool that never ran pre-crash), and
//   3. keeps a VALID OpenAI message history throughout (every tool_call has a matching result — the
//      approval-exit invariant holds across the restart), the journal records the mutation with a live
//      inverse, and the resumed SSE stream continues at startSeq with NO gap or duplicate vs what a
//      client already saw. It NEVER re-calls the model for the interrupted turn's completed part.
// Run: `npm run resumeconsumer:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type OpenAI from "openai";
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Registry, type Tool } from "./tools/index.ts";
import { AgentRunner, type TurnState } from "./loop.ts";
import { writeFile } from "./tools/files.ts";
import { wellFormed } from "./testutil.ts";
import { type ApprovalGate, type ApprovalRequest, type Decision } from "./approvals.ts";
import type { AgentEvent, EventSink } from "./events.ts";

const dbPath = join(tmpdir(), `errand-resumeconsumer-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // set BEFORE importing store
const store = await import("./server/store.ts");
const { rebuildJournalFromStore } = await import("./server/journalRestore.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

// A sink that mirrors the live host: it persists every non-delta event to the store (so the resumed
// runner's startSeq and a reconnecting client both read a real event log) and taps them for asserts.
class PersistingSink implements EventSink {
  events: AgentEvent[] = [];
  constructor(private runId: string) {}
  emit(e: AgentEvent) {
    this.events.push(e);
    if (e.type !== "message.delta") store.appendEvent(this.runId, e);
  }
}

// A gate that PARKS the approval promise (like the web host's WebGate) and lets the test resolve it
// out-of-band (the /decision equivalent). Also signals when a request arrives so the test can act.
class ParkingGate implements ApprovalGate {
  pending = new Map<string, (d: Decision) => void>();
  requested: string[] = [];
  private waiters: ((id: string) => void)[] = [];
  autoApproves(): boolean {
    return false;
  }
  request(req: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    this.requested.push(req.callId);
    for (const w of this.waiters.splice(0)) w(req.callId);
    return new Promise<Decision>((resolve) => {
      if (signal.aborted) return resolve("cancelled");
      const finish = (d: Decision) => {
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(req.callId);
        resolve(d);
      };
      const onAbort = () => finish("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(req.callId, finish);
    });
  }
  // Wait until request() is next called (approval re-parked), resolving with its callId.
  waitForRequest(): Promise<string> {
    return new Promise((res) => this.waiters.push(res));
  }
  // The /decision equivalent: resolve a parked approval by callId. false if nothing is parked.
  decide(callId: string, d: Decision): boolean {
    const f = this.pending.get(callId);
    if (!f) return false;
    f(d);
    return true;
  }
}

const toolCallResp = (name: string, callId: string, args: unknown) => ({
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
});
const textResp = (text: string) => ({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: null });
function stubClient(responder: (i: number) => any): OpenAI {
  let i = 0;
  return { chat: { completions: { create: async () => responder(i++) } } } as unknown as OpenAI;
}

async function main(): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), "errand-resumeconsumer-ws-"));
  const target = join(ws, "note.txt");
  const runId = crypto.randomUUID();
  const reg = new Registry();
  reg.register(writeFile);
  store.createRun(runId, "resume consumer", Date.now(), [ws]);

  // ---- PHASE A: drive the run to a PERSISTED pre-approval checkpoint, then "crash" ----
  const gate1 = new ParkingGate();
  const sink1 = new PersistingSink(runId);
  const session1 = new Session("system");
  const captured: TurnState[] = [];
  const runner1 = new AgentRunner({
    session: session1,
    sink: sink1,
    registry: reg,
    model: "stub",
    logger: new Logger(runId),
    runId,
    client: stubClient(() => toolCallResp("write_file", "call-write", { path: target, content: "HELLO FROM RESUME" })),
    stream: false,
    gate: gate1,
    workspaceRoot: ws,
    roots: [ws],
    // Persist the checkpoint to the store exactly like the live host's checkpointFor.
    checkpoint: (s) => {
      captured.push(JSON.parse(JSON.stringify(s)));
      store.saveTurnState(runId, { ...s, autoApproveReversible: false });
    },
  });

  // send() parks on the approval — DON'T await it (that is the process being killed mid-approval).
  const parked = runner1.send("write a note", new AbortController().signal);
  parked.catch(() => {}); // the killed process never settles this; swallow so it isn't unhandled
  const parkedCallId = await gate1.waitForRequest();

  check("phase A parked on the write's approval", parkedCallId === "call-write");
  check("the mutation did NOT run before approval (file absent)", !existsSync(target));
  const savedTs = store.getTurnState(runId);
  check("turn_state persisted at the pre-approval boundary", !!savedTs && savedTs.phase === "awaiting_approval" && savedTs.pendingCallId === "call-write");
  check("the run is now RESUMABLE (working + a checkpoint)", store.isResumable(runId) === true);
  const persistedA = store.getEvents(runId);
  check("pre-crash events persisted (incl. approval.required)", persistedA.some((e) => e.type === "approval.required" && (e as any).callId === "call-write"));
  const maxSeqA = persistedA.length ? persistedA[persistedA.length - 1].seq : -1;

  // ---- "RESTART": drop ALL in-memory runner state. Rebuild purely from the persisted store. ----
  const state = store.getTurnState(runId)!;
  const startSeq = maxSeqA + 1; // mirrors rehydrate(): max PERSISTED event seq + 1

  const gate2 = new ParkingGate();
  const sink2 = new PersistingSink(runId);
  const session2 = new Session("system"); // fresh + empty; resume loads the snapshot itself
  rebuildJournalFromStore(runId, session2.journal); // no ops yet, but this is what rehydrate does
  const runner2 = new AgentRunner({
    session: session2,
    sink: sink2,
    registry: reg,
    model: "stub",
    logger: new Logger(runId),
    runId,
    // After the (re-run) tool, the next model call ends the turn with a final reply.
    client: stubClient(() => textResp("Done — I saved the note.")),
    stream: false,
    gate: gate2,
    workspaceRoot: ws,
    roots: [ws],
    startSeq,
    checkpoint: (s) => store.saveTurnState(runId, { ...s, autoApproveReversible: false }),
  });

  // ---- RESUME: re-enter the interrupted turn. It re-parks the approval; we resolve it (the /decision). ----
  const resumed = runner2.resume(state as any, new AbortController().signal);
  const reparkedCallId = await gate2.waitForRequest();
  check("RESUME re-registered the pending approval (same callId)", reparkedCallId === "call-write");
  check("the resumed approval is resolvable by /decision (callId is parked)", gate2.pending.has("call-write"));

  const decided = gate2.decide("call-write", "approved"); // the browser clicks Approve
  check("a /decision-style approve resolves the re-parked approval", decided === true);
  const finalText = await resumed;

  // ---- ASSERTIONS: valid history, mutation applied, journal + undo, seq continuity ----
  check("resume ran to a clean completion", finalText === "Done — I saved the note.");
  check("VALID OpenAI history after resume (no stranded tool_call)", wellFormed(session2.messages as any).ok, wellFormed(session2.messages as any).detail);
  check("the mutation actually ran on approval (file written)", existsSync(target) && readFileSync(target, "utf8") === "HELLO FROM RESUME");
  const everyCallHasResult = (session2.messages as any[]).filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls)).every((m) => m.tool_calls.every((c: any) => (session2.messages as any[]).some((x) => x.role === "tool" && x.tool_call_id === c.id)));
  check("the write's tool_call has a matching REAL result (approval-exit invariant)", everyCallHasResult);

  // The model was NOT re-called for the interrupted turn's completion — the assistant tool_calls
  // message came from the snapshot, and the ONLY model call in phase B is the post-tool finishing turn.
  check("journal recorded the write with a live inverse", session2.journal.reversibleCount() === 1);
  const undo = await session2.journal.undoAll();
  check(`whole-run undo reversed the write (undone=1) (got ${JSON.stringify(undo)})`, undo.undone === 1 && undo.failed === 0);
  check("undo removed the created file", !existsSync(target));

  // Seq continuity: every event the RESUME emitted sits at/above startSeq (never re-uses a seq a
  // client already saw), and the full persisted stream has strictly increasing, unique structural seqs.
  const resumeEmitted = sink2.events;
  check("every resumed event seq >= startSeq (no collision with pre-crash seqs)", resumeEmitted.every((e) => e.seq >= startSeq), `startSeq=${startSeq}`);
  const finalStream = store.getEvents(runId).filter((e) => e.type !== "message.delta");
  let monotonic = true;
  const seen = new Set<number>();
  for (let k = 0; k < finalStream.length; k++) {
    if (seen.has(finalStream[k].seq)) monotonic = false;
    seen.add(finalStream[k].seq);
    if (k > 0 && finalStream[k].seq <= finalStream[k - 1].seq) monotonic = false;
  }
  check("full persisted structural stream: strictly increasing + no duplicate seq", monotonic, `[${finalStream.map((e) => e.seq).join(",")}]`);
  // A reconnecting client at Last-Event-ID = maxSeqA gets exactly the post-crash events, none dropped.
  const afterReconnect = finalStream.filter((e) => e.seq > maxSeqA);
  check("a client reconnecting at the pre-crash boundary receives the resume events (none dropped)", afterReconnect.length >= 2 && afterReconnect.some((e) => e.type === "run.finished"));

  rmSync(ws, { recursive: true, force: true });

  await testInflightGuard();

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// The IRREVERSIBLE double-execution guard: a permanent tool killed MID-RUN (after approval) leaves a
// tool_inflight marker. On resume the loop must NOT re-run it — it marks the call uncertain so a
// send-email / pay never fires twice. Here we seed exactly that persisted state and resume it.
async function testInflightGuard(): Promise<void> {
  console.log("\n-- tool_inflight guard: a permanent tool killed mid-run is NOT re-executed --");
  const runId = crypto.randomUUID();
  const reg = new Registry();
  let ran = 0;
  const sendEmail: Tool<Record<string, never>> = {
    name: "send_email",
    modelDescription: "send an email",
    jsonSchema: { type: "object", properties: {} },
    argsSchema: z.object({}) as any,
    gated: true,
    describe: () => ({ action: "Send the email", reversibility: "permanent", consequences: "This can't be undone." }),
    summarize: () => "Sent.",
    run: async () => {
      ran++;
      return { ok: true, data: {} };
    },
  };
  reg.register(sendEmail);
  store.createRun(runId, "inflight guard", Date.now(), ["/tmp"]);

  // Persisted crash state: parked-then-approved-then-running when killed. The awaiting_approval
  // checkpoint's 400-safe snapshot + a surviving inflight marker for the call that was executing.
  const snapshot = [
    { role: "system", content: "system" },
    { role: "user", content: "email bob" },
    { role: "assistant", content: null, tool_calls: [{ id: "send-1", type: "function", function: { name: "send_email", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "send-1", content: '{"ok":false,"error":"interrupted"}' },
  ];
  for (let seq = 0; seq <= 6; seq++) store.appendEvent(runId, { runId, turnId: "t", seq, ts: 1, type: "turn.started", index: 0, maxIterations: 300 } as any);
  store.saveTurnState(runId, {
    turnId: "t",
    phase: "awaiting_approval",
    iteration: 0,
    callCursor: 0,
    pendingCallId: "send-1",
    messages: snapshot,
    callCounts: {},
    autoApproveReversible: false,
    maxEmittedSeq: 6,
  });
  store.saveInflight(runId, "send-1", "send_email", "permanent");

  const sink = new PersistingSink(runId);
  const session = new Session("system");
  const runner = new AgentRunner({
    session,
    sink,
    registry: reg,
    model: "stub",
    logger: new Logger(runId),
    runId,
    client: stubClient(() => textResp("I wasn't sure that email sent, so I left it — check and let me know.")),
    stream: false,
    startSeq: 7,
    markInflight: (c, t, r) => store.saveInflight(runId, c, t, r),
    clearInflight: (c) => store.clearInflight(runId, c),
  });

  const inflight = store.getInflightIds(runId);
  check("the killed run has a surviving inflight marker for the send", inflight.has("send-1"));
  await runner.resume(store.getTurnState(runId)! as any, new AbortController().signal, inflight);

  check("the permanent tool was NOT re-executed (no double-send)", ran === 0, `ran=${ran}`);
  check("resume kept a VALID history (uncertain result stands in for the call)", wellFormed(session.messages as any).ok);
  const sendResult = sink.events.find((e) => e.type === "tool.result" && (e as any).callId === "send-1");
  check("the re-parked call was resolved as NOT-ok (uncertain), not silently succeeded", !!sendResult && (sendResult as any).ok === false);
  check("the inflight marker was cleared after the guard fired", !store.getInflightIds(runId).has("send-1"));
  check("the run settled cleanly", sink.events.some((e) => e.type === "run.finished"));
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
