// Journal honesty suite (rank 17) — pure, no DB, no network. The journal is the Undo engine;
// its promises are "never lie about reversibility" (a reversible label with no inverse is
// demoted) and "a half-failed undo still reports honestly". These paths aren't covered by the
// simple skip-one case in v2test.
import { Journal } from "./journal.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

function testDemotion() {
  console.log("\n== reversible-without-inverse is demoted, never undoable ==");
  const j = new Journal();
  j.record({ op: "write", description: "claims reversible but has no inverse", reversibility: "reversible" });
  const e = j.list()[0];
  check("label demoted to 'unknown' (not a lie)", e.reversibility === "unknown", e.reversibility);
  check("excluded from reversibleCount()", j.reversibleCount() === 0);
}

function testLabelsKept() {
  console.log("\n== labels with a real inverse / genuine permanence are kept ==");
  const j = new Journal();
  j.record({ op: "move", description: "real inverse", reversibility: "reversible", inverse: async () => {} });
  j.record({ op: "send", description: "one-way", reversibility: "permanent" });
  const [rev, perm] = j.list();
  check("reversible-with-inverse stays 'reversible'", rev.reversibility === "reversible");
  check("permanent stays 'permanent'", perm.reversibility === "permanent");
  check("only the one with an inverse counts as reversible", j.reversibleCount() === 1);
}

async function testPartialFailureAndLifo() {
  console.log("\n== undoAll: LIFO order + a throwing inverse is counted, others still run ==");
  const order: string[] = [];
  const j = new Journal();
  j.record({ op: "a", description: "first", reversibility: "reversible", inverse: async () => void order.push("a") });
  j.record({
    op: "b",
    description: "second (throws)",
    reversibility: "reversible",
    inverse: async () => {
      order.push("b-attempt");
      throw new Error("boom");
    },
  });
  j.record({ op: "c", description: "third", reversibility: "reversible", inverse: async () => void order.push("c") });

  const res = await j.undoAll();
  check(`accounting is {undone:2, failed:1, skipped:0} (got ${JSON.stringify(res)})`, res.undone === 2 && res.failed === 1 && res.skipped === 0);
  check("the failing inverse did NOT stop the others", order.includes("a") && order.includes("c"));
  // LIFO: c (last recorded) is attempted before a (first recorded).
  check("undone in REVERSE order (c before a)", order.indexOf("c") < order.indexOf("a"), order.join(","));
  check("the throwing inverse was actually attempted", order.includes("b-attempt"));
}

async function testSkipAndEmpty() {
  console.log("\n== mixed reversible/non + empty journal ==");
  const j = new Journal();
  j.record({ op: "x", description: "reversible", reversibility: "reversible", inverse: async () => {} });
  j.record({ op: "y", description: "no inverse", reversibility: "unknown" });
  const res = await j.undoAll();
  check(`{undone:1, failed:0, skipped:1} (got ${JSON.stringify(res)})`, res.undone === 1 && res.failed === 0 && res.skipped === 1);

  const empty = await new Journal().undoAll();
  check("empty journal -> all zeros", empty.undone === 0 && empty.failed === 0 && empty.skipped === 0);
}

async function testDoubleUndoIsNoOp() {
  console.log("\n== undone entries are excluded + a second undoAll is a true no-op (stale-undo guard) ==");
  let deletes = 0;
  const j = new Journal();
  j.record({ op: "make_folder", description: "Made a folder", reversibility: "reversible", inverse: async () => void deletes++ });
  j.record({ op: "move", description: "Moved a file", reversibility: "reversible", inverse: async () => void deletes++ });

  check("both reversible before undo", j.reversibleCount() === 2);
  const first = await j.undoAll();
  check(`first undoAll reverses both ({undone:2}) (got ${JSON.stringify(first)})`, first.undone === 2 && first.failed === 0 && first.skipped === 0);
  check("both inverses ran exactly once", deletes === 2, `${deletes}`);
  check("entries marked undone -> reversibleCount is now 0", j.reversibleCount() === 0);
  check("list() entries carry undone=true", j.list().every((e) => e.undone === true));

  // The bug this guards: a SECOND undoAll (or a next completion re-listing the same cumulative
  // journal) must NOT re-run any inverse — otherwise a re-created folder gets re-deleted.
  const second = await j.undoAll();
  check(`second undoAll is all-zeros (no-op) (got ${JSON.stringify(second)})`, second.undone === 0 && second.failed === 0 && second.skipped === 0);
  check("no inverse ran again on the second undo", deletes === 2, `${deletes}`);
}

async function testFailedUndoStaysRetryable() {
  console.log("\n== a FAILED inverse is not marked undone (stays retryable) ==");
  let attempts = 0;
  const j = new Journal();
  j.record({
    op: "move",
    description: "flaky",
    reversibility: "reversible",
    inverse: async () => {
      attempts++;
      if (attempts === 1) throw new Error("boom"); // fail the first time, succeed the second
    },
  });
  const first = await j.undoAll();
  check(`first undoAll counts the failure ({failed:1}) (got ${JSON.stringify(first)})`, first.failed === 1 && first.undone === 0);
  check("failed entry NOT marked undone -> still reversible", j.reversibleCount() === 1);
  const second = await j.undoAll();
  check(`retry succeeds ({undone:1}) (got ${JSON.stringify(second)})`, second.undone === 1 && second.failed === 0);
  check("now marked undone -> reversibleCount 0", j.reversibleCount() === 0);
}

function testOnRecordHook() {
  console.log("\n== onRecord fires SYNCHRONOUSLY at record-time (manifest persisted before the fs window) ==");
  const j = new Journal();
  const seen: { id: string; manifest: unknown; reversibility: string }[] = [];
  let firedSynchronously = false;
  j.onRecord = (e) => seen.push({ id: e.id, manifest: e.manifest, reversibility: e.reversibility });

  const id = j.record({
    op: "write",
    description: "wrote a file",
    reversibility: "reversible",
    inverse: async () => {},
    manifest: { kind: "write", path: "/x/a.txt", wasNew: true, snapshot: null },
  });
  firedSynchronously = seen.length === 1; // checked immediately after record() returns — no await
  check("onRecord fired exactly once, synchronously during record()", firedSynchronously);
  check("...with the generated id and the manifest intact", seen[0]?.id === id && (seen[0]?.manifest as any)?.kind === "write");

  // It receives the FINAL entry — a reversible-without-inverse is demoted before the hook sees it.
  const seen2: string[] = [];
  const j2 = new Journal();
  j2.onRecord = (e) => seen2.push(e.reversibility);
  j2.record({ op: "write", description: "no inverse", reversibility: "reversible" });
  check("onRecord sees the demoted reversibility ('unknown'), not the claimed one", seen2[0] === "unknown", seen2[0]);

  // A throwing hook must NOT break record() (persistence failure can't lose the in-memory op).
  const j3 = new Journal();
  j3.onRecord = () => {
    throw new Error("disk full");
  };
  let threw = false;
  let rid = "";
  try {
    rid = j3.record({ op: "move", description: "m", reversibility: "reversible", inverse: async () => {} });
  } catch {
    threw = true;
  }
  check("a throwing onRecord does not break record()", !threw && !!rid && j3.list().length === 1);

  // No hook set -> record() works exactly as before (no throw).
  const j4 = new Journal();
  j4.record({ op: "x", description: "no hook", reversibility: "unknown" });
  check("record() works with no onRecord set", j4.list().length === 1);
}

async function testOnUndoneHook() {
  console.log("\n== onUndone fires once per successfully-reversed entry (persists whole-run-undo state) ==");
  const undoneIds: string[] = [];
  const j = new Journal();
  j.onUndone = (e) => undoneIds.push(e.id);
  const a = j.record({ op: "a", description: "first", reversibility: "reversible", inverse: async () => {} });
  const b = j.record({ op: "b", description: "second", reversibility: "reversible", inverse: async () => {} });
  await j.undoAll();
  check("onUndone fired for BOTH reversed entries", undoneIds.length === 2 && undoneIds.includes(a) && undoneIds.includes(b));

  // A SECOND undoAll must NOT re-fire onUndone (entries already undone → skipped).
  await j.undoAll();
  check("onUndone did NOT fire again on a second undoAll", undoneIds.length === 2);

  // A FAILED inverse must NOT fire onUndone (only a successful reversal persists undone).
  const seen: string[] = [];
  const j2 = new Journal();
  j2.onUndone = (e) => seen.push(e.id);
  j2.record({ op: "boom", description: "throws", reversibility: "reversible", inverse: async () => { throw new Error("x"); } });
  await j2.undoAll();
  check("onUndone did NOT fire for a failed inverse (stays retryable)", seen.length === 0);

  // A restored entry that arrives already-undone (record({undone:true})) is excluded + never re-run.
  let ran = 0;
  const j3 = new Journal();
  j3.record({ op: "restored", description: "already undone", reversibility: "reversible", inverse: async () => void ran++, undone: true });
  check("record({undone:true}) is excluded from reversibleCount", j3.reversibleCount() === 0);
  const r = await j3.undoAll();
  check("an already-undone restored entry is skipped, inverse never runs", ran === 0 && r.undone === 0 && r.skipped === 0);

  // A throwing onUndone must NOT break undoAll (persistence failure can't corrupt the reversal).
  const j5 = new Journal();
  j5.onUndone = () => { throw new Error("disk full"); };
  j5.record({ op: "m", description: "m", reversibility: "reversible", inverse: async () => {} });
  const r5 = await j5.undoAll();
  check("a throwing onUndone does not break undoAll", r5.undone === 1 && r5.failed === 0);
}

async function main() {
  testDemotion();
  testLabelsKept();
  await testPartialFailureAndLifo();
  await testSkipAndEmpty();
  await testDoubleUndoIsNoOp();
  await testFailedUndoStaysRetryable();
  testOnRecordHook();
  await testOnUndoneHook();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
