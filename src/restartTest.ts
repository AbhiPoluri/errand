// Verifies restart-hardening: reconcileOrphans() turns zombie 'working' runs (left by a
// killed process) into a clean interrupted state — resolving parked approvals and appending a
// terminal event — without touching live or already-finished runs. Runs against an isolated
// temp DB (ERRAND_DB). Run: `npm run restart:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
// These don't touch the DB, so they're safe to import statically (before ERRAND_DB is set).
import { Journal } from "./journal.ts";
import { writeFile, moveFile, deleteFile, renameFile, makeFolder } from "./tools/files.ts";
import type { ToolContext } from "./tools/index.ts";

const dbPath = join(tmpdir(), `errand-restarttest-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // MUST be set before store.ts opens the DB
const store = await import("./server/store.ts");
// journalRestore + runRegistry transitively open the DB, so import them AFTER ERRAND_DB is set.
const { rebuildJournalFromStore, reconstructInverse } = await import("./server/journalRestore.ts");
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

  // RESUMABLE: a working run with a durable mid-turn checkpoint. Reconcile must LEAVE it alone (it is
  // re-entered by rehydrate() on next access, which re-parks any pending approval + continues the loop).
  // Only CHECKPOINT-LESS working runs (parked, midtask) are true dead-ends that get force-stopped here.
  store.createRun("resumable", "Resumable mid-turn", 1, ["/tmp"]);
  store.appendEvent("resumable", ev("resumable", 0, { type: "run.started", title: "Resumable mid-turn" }));
  const cp = () => ({
    turnId: "t", phase: "executing_tools", iteration: 0, callCursor: 0, pendingCallId: null,
    messages: [], callCounts: {}, autoApproveReversible: false, maxEmittedSeq: 0,
  });
  store.saveTurnState("resumable", cp());
  store.saveTurnState("live", cp());
  check("isResumable: a working run WITH a checkpoint is resumable", store.isResumable("resumable") === true);
  check("isResumable: a working run WITHOUT a checkpoint is NOT", store.isResumable("parked") === false);

  const n = store.reconcileOrphans(new Set(["live"]));
  check(`reconciled exactly 2 checkpoint-less orphans (parked + midtask); live + resumable skipped (got ${n})`, n === 2);

  const status = (id: string) => store.listRunSummaries().find((r) => r.runId === id)?.status;
  check("parked → stopped", status("parked") === "stopped");
  check("midtask → stopped", status("midtask") === "stopped");
  check("live untouched (still working)", status("live") === "working");
  check("done untouched (still done)", status("done") === "done");
  check("resumable run left WORKING (reconcile skips a checkpointed run)", status("resumable") === "working");
  check("resumable run's checkpoint kept (available for resume-on-access)", store.getTurnState("resumable") !== null);
  check("isResumable: a stopped run is no longer resumable", store.isResumable("midtask") === false);
  check("reconcile LEFT the live run's turn_state", store.getTurnState("live") !== null);

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

  // ---- Undo survives restart: rebuild inverses from the manifest, undoAll restores state ----
  console.log("\n-- journal manifest restore --");
  const ws = mkdtempSync(join(tmpdir(), "errand-undo-"));
  const ctx = (journal: Journal): ToolContext => ({
    signal: new AbortController().signal,
    journal,
    runId: "undorun",
    workspaceRoot: ws,
    roots: [ws],
  });
  const live = new Journal();
  const lc = ctx(live);
  const existing = join(ws, "report.txt");
  writeFileSync(existing, "ORIGINAL");
  await writeFile.run({ path: existing, content: "OVERWRITTEN" }, lc); // overwrite (snapshots prior)
  await writeFile.run({ path: join(ws, "fresh.txt"), content: "NEW" }, lc); // brand-new file
  const moveSrc = join(ws, "a.txt");
  writeFileSync(moveSrc, "MOVE ME");
  await moveFile.run({ from: moveSrc, to: join(ws, "moved.txt") }, lc);
  const delTarget = join(ws, "trash.txt");
  writeFileSync(delTarget, "DELETE ME");
  await deleteFile.run({ path: delTarget }, lc);
  const renSrc = join(ws, "old-name.txt");
  writeFileSync(renSrc, "RENAME ME");
  await renameFile.run({ path: renSrc, newName: "new-name.txt" }, lc);

  // Persist the manifest as runTurn.finally would, then drop the live journal entirely.
  for (const e of live.list())
    store.appendJournalOp("undorun", {
      opId: e.id, op: e.op, description: e.description, reversibility: e.reversibility, manifest: e.manifest,
    });
  check("persisted 5 journal ops", store.getJournalOps("undorun").length === 5);

  // "Restart": a fresh journal with NO live closures, rebuilt purely from the persisted manifest.
  const restored = new Journal();
  rebuildJournalFromStore("undorun", restored);
  check("rebuilt 5 reversible inverses from manifest", restored.reversibleCount() === 5);
  const undo = await restored.undoAll();
  check(`restart undoAll undone=5 failed=0 (got ${JSON.stringify(undo)})`, undo.undone === 5 && undo.failed === 0);
  check("write-over restored prior bytes", existsSync(existing) && readFileSync(existing, "utf8") === "ORIGINAL");
  check("brand-new file removed by undo", !existsSync(join(ws, "fresh.txt")));
  check("move undone (back to a.txt)", existsSync(moveSrc) && !existsSync(join(ws, "moved.txt")));
  check("delete undone (trash.txt restored)", existsSync(delTarget) && readFileSync(delTarget, "utf8") === "DELETE ME");
  check("rename undone (old-name.txt restored)", existsSync(renSrc) && !existsSync(join(ws, "new-name.txt")));

  // Double-undo idempotency: recreate an unrelated file at the move's old destination, undo
  // AGAIN, and confirm the reconstructed inverse does NOT clobber the already-restored file.
  writeFileSync(join(ws, "moved.txt"), "UNRELATED");
  await restored.undoAll();
  check("double-undo did not clobber the restored file", readFileSync(moveSrc, "utf8") === "MOVE ME");
  check(
    "double-undo left the unrelated file intact",
    existsSync(join(ws, "moved.txt")) && readFileSync(join(ws, "moved.txt"), "utf8") === "UNRELATED",
  );

  // A corrupt-but-known-kind manifest (valid JSON, missing required fields — e.g. schema drift or
  // a partial write) must reconstruct to NO inverse, not a closure that lies about undoability.
  check("corrupt move manifest -> no inverse", reconstructInverse({ manifest: { kind: "move" } as any }) === undefined);
  check("corrupt copy manifest -> no inverse", reconstructInverse({ manifest: { kind: "copy" } as any }) === undefined);
  check("corrupt write manifest -> no inverse", reconstructInverse({ manifest: { kind: "write", wasNew: true } as any }) === undefined);
  check("corrupt make_folder manifest -> no inverse", reconstructInverse({ manifest: { kind: "make_folder" } as any }) === undefined);
  check("corrupt delete manifest -> no inverse", reconstructInverse({ manifest: { kind: "delete" } as any }) === undefined);
  check("valid move manifest -> has a real inverse", typeof reconstructInverse({ manifest: { kind: "move", from: "/a", to: "/b" } }) === "function");

  // ---- copy + make_folder reconstructed inverses RUN correctly (the restart-Undo fallback the
  //      end-to-end section above never exercises — it only does move/write/delete/rename) ----
  console.log("\n-- copy + make_folder reconstructed inverses --");
  const rdir = mkdtempSync(join(tmpdir(), "errand-reconstruct-"));

  // copy: the inverse removes the copied file.
  const copied = join(rdir, "copied.txt");
  writeFileSync(copied, "A COPY");
  const copyInv = reconstructInverse({ manifest: { kind: "copy", to: copied } });
  check("copy manifest -> has an inverse", typeof copyInv === "function");
  await copyInv!();
  check("copy inverse removed the copied file", !existsSync(copied));

  // make_folder: removes an EMPTY created folder…
  const emptyDir = join(rdir, "empty-made");
  mkdirSync(emptyDir);
  const mfInv = reconstructInverse({ manifest: { kind: "make_folder", path: emptyDir } });
  check("make_folder manifest -> has an inverse", typeof mfInv === "function");
  await mfInv!();
  check("make_folder inverse removed the empty created folder", !existsSync(emptyDir));

  // …but LEAVES a folder the user has since filled — the load-bearing safety guard (never delete a
  // folder that now holds the user's data, even though make_folder created it).
  const filledDir = join(rdir, "filled-made");
  mkdirSync(filledDir);
  const userFile = join(filledDir, "user-put-this-here.txt");
  writeFileSync(userFile, "USER DATA");
  await reconstructInverse({ manifest: { kind: "make_folder", path: filledDir } })!();
  check("make_folder inverse LEAVES a folder the user filled", existsSync(filledDir) && existsSync(userFile));

  rmSync(rdir, { recursive: true, force: true });

  // ---- undoRun() on a run NOT in memory rehydrates + rebuilds instead of 404ing ----
  console.log("\n-- undoRun on an out-of-memory run --");
  const ws2 = mkdtempSync(join(tmpdir(), "errand-undorun-"));
  store.createRun("oom-run", "out of memory run", 1, [ws2]);
  const target2 = join(ws2, "keep.txt");
  writeFileSync(target2, "KEEP ME");
  const j2 = new Journal();
  await deleteFile.run(
    { path: target2 },
    { signal: new AbortController().signal, journal: j2, runId: "oom-run", workspaceRoot: ws2, roots: [ws2] },
  );
  for (const e of j2.list())
    store.appendJournalOp("oom-run", {
      opId: e.id, op: e.op, description: e.description, reversibility: e.reversibility, manifest: e.manifest,
    });
  check("oom-run: file starts in the deleted state", !existsSync(target2));
  const reg = await import("./server/runRegistry.ts");
  const res = await reg.undoRun("oom-run");
  check("undoRun did NOT return null for an out-of-memory run", res !== null);
  check("undoRun restored the file via the rebuilt journal", existsSync(target2) && readFileSync(target2, "utf8") === "KEEP ME");
  check(`undoRun reported undone>=1, failed=0 (got ${JSON.stringify(res)})`, !!res && res.undone >= 1 && res.failed === 0);
  // Whole-run undo is idempotent ACROSS a restart: the first undoRun persisted `undone`, so a SECOND
  // undoRun (rebuilding a fresh throwaway journal from the store) is a true no-op — it can't re-run an
  // inverse and, e.g., re-delete a file the user has since re-created.
  const res2 = await reg.undoRun("oom-run");
  check(`second undoRun is a no-op — persisted undone respected (got ${JSON.stringify(res2)})`, !!res2 && res2.undone === 0 && res2.failed === 0);
  check("second undoRun left the restored file intact", existsSync(target2) && readFileSync(target2, "utf8") === "KEEP ME");

  // ---- persisted `undone` flag: a whole-run undo's state survives eviction/restart ----
  // Without persistence, a rehydrated run rebuilds every op with undone=false, so a SECOND whole-run
  // undo re-runs the inverse (the stale-undo re-delete risk). markJournalOpUndone + the restore in
  // rebuildJournalFromStore close that.
  console.log("\n-- persisted undone flag (whole-run-undo survives restart) --");
  const ws3 = mkdtempSync(join(tmpdir(), "errand-undone-"));
  store.createRun("undone-run", "undone persistence", 1, [ws3]);
  const folder = join(ws3, "made-folder");
  const jU = new Journal();
  // Persist undone the instant undoAll reverses each op (as the live/throwaway host wires it).
  jU.onUndone = (e) => store.markJournalOpUndone("undone-run", e.id);
  await makeFolder.run(
    { path: folder },
    { signal: new AbortController().signal, journal: jU, runId: "undone-run", workspaceRoot: ws3, roots: [ws3] },
  );
  for (const e of jU.list())
    store.appendJournalOp("undone-run", { opId: e.id, op: e.op, description: e.description, reversibility: e.reversibility, manifest: e.manifest });
  check("undone-run: folder created", existsSync(folder));
  const u1 = await jU.undoAll();
  check(`first undo removed the folder (undone=1) (got ${JSON.stringify(u1)})`, u1.undone === 1 && !existsSync(folder));
  check("store persisted undone=1 for the op", store.getJournalOps("undone-run").every((o) => o.undone === true));

  // The user RE-CREATES the folder and puts data in it — the classic stale-undo re-delete target.
  mkdirSync(folder);
  const precious = join(folder, "precious.txt");
  writeFileSync(precious, "USER DATA");
  // "Restart": rebuild a fresh journal purely from the store; the restored undone flag must exclude it.
  const jU2 = new Journal();
  jU2.onUndone = (e) => store.markJournalOpUndone("undone-run", e.id);
  rebuildJournalFromStore("undone-run", jU2);
  check("rehydrated journal restored undone=true -> reversibleCount 0", jU2.reversibleCount() === 0);
  const u2 = await jU2.undoAll();
  check(`second whole-run undo is a no-op (got ${JSON.stringify(u2)})`, u2.undone === 0 && u2.failed === 0);
  check("the user's re-created folder + data were NOT re-deleted", existsSync(folder) && readFileSync(precious, "utf8") === "USER DATA");

  rmSync(ws3, { recursive: true, force: true });

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
