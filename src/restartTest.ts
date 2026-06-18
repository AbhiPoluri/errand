// Verifies restart-hardening: reconcileOrphans() turns zombie 'working' runs (left by a
// killed process) into a clean interrupted state — resolving parked approvals and appending a
// terminal event — without touching live or already-finished runs. Runs against an isolated
// temp DB (ERRAND_DB). Run: `npm run restart:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dbPath = join(tmpdir(), `errand-restarttest-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // MUST be set before store.ts opens the DB
const store = await import("./server/store.ts");
import type { AgentEvent } from "./events.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

// Minimal event factory (only the fields each variant needs).
function ev(runId: string, seq: number, body: any): AgentEvent {
  return { runId, turnId: "t1", seq, ts: 1, ...body } as AgentEvent;
}

async function main(): Promise<void> {
  // PARKED: a working run suspended on an unresolved approval (callId "c1").
  store.createRun("parked", "Parked on approval", 1, ["/tmp"]);
  store.appendEvent("parked", ev("parked", 0, { type: "run.started", title: "Parked on approval" }));
  store.appendEvent("parked", ev("parked", 1, { type: "user.message", text: "delete the old files" }));
  store.appendEvent("parked", ev("parked", 2, {
    type: "approval.required", callId: "c1", action: "Move 3 files to Review",
    consequences: "They go to a Review folder.", items: ["a", "b", "c"], reversibility: "reversible",
  }));

  // MIDTASK: a working run killed mid-step, no approval pending.
  store.createRun("midtask", "Mid task", 1, ["/tmp"]);
  store.appendEvent("midtask", ev("midtask", 0, { type: "run.started", title: "Mid task" }));
  store.appendEvent("midtask", ev("midtask", 1, { type: "tool.started", callId: "x1", action: "Reading folder" }));

  // LIVE: a working run we pretend is still executing in memory — must be skipped.
  store.createRun("live", "Live run", 1, ["/tmp"]);
  store.appendEvent("live", ev("live", 0, { type: "run.started", title: "Live run" }));

  // DONE: already finished — must be untouched.
  store.createRun("done", "Done run", 1, ["/tmp"]);
  store.setStatus("done", "done");

  const n = store.reconcileOrphans(new Set(["live"]));
  check(`reconciled exactly 2 orphans (parked + midtask), live skipped (got ${n})`, n === 2);

  const status = (id: string) => store.listRunSummaries().find((r) => r.runId === id)?.status;
  check("parked → stopped", status("parked") === "stopped");
  check("midtask → stopped", status("midtask") === "stopped");
  check("live untouched (still working)", status("live") === "working");
  check("done untouched (still done)", status("done") === "done");

  // Parked run: its approval was resolved to cancelled, then a terminal interrupted event added.
  const pe = store.getEvents("parked");
  const resolvedC1 = pe.find((e) => e.type === "approval.resolved" && e.callId === "c1");
  check("parked: approval c1 resolved", !!resolvedC1 && (resolvedC1 as any).decision === "cancelled");
  const pLast = pe[pe.length - 1];
  check("parked: last event is run.error/cancelled interrupted",
    pLast?.type === "run.error" && (pLast as any).kind === "cancelled" && (pLast as any).userMessage.includes("interrupted"));
  check("parked: seqs stay monotonic", pe.every((e, i) => i === 0 || e.seq > pe[i - 1].seq));

  // Midtask run: terminal event added, but NO spurious approval.resolved (there was no approval).
  const me = store.getEvents("midtask");
  check("midtask: no approval.resolved injected", !me.some((e) => e.type === "approval.resolved"));
  check("midtask: last event is run.error/cancelled interrupted",
    me[me.length - 1]?.type === "run.error" && (me[me.length - 1] as any).kind === "cancelled");

  // Live run: nothing appended.
  check("live: no events appended", store.getEvents("live").length === 1);

  // Idempotent: a second boot finds nothing left to reconcile.
  check("second reconcile is a no-op", store.reconcileOrphans(new Set(["live"])) === 0);

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

await main().finally(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* temp file — ignore */
  }
});
