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

async function main() {
  testDemotion();
  testLabelsKept();
  await testPartialFailureAndLifo();
  await testSkipAndEmpty();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
