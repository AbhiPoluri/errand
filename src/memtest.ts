// Verifies embedding-based memory retrieval end-to-end: seed many DIVERSE memories, then
// confirm relevantMemories()/rankMemories() surface the ones actually related to a query —
// not just the newest. Runs against an isolated temp DB (ERRAND_DB) so it never touches the
// real errand.db. Run: `npx tsx src/memtest.ts`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dbPath = join(tmpdir(), `errand-memtest-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // MUST be set before store.ts opens the DB
const store = await import("./server/store.ts");

// 16 memories across clearly distinct domains so the "right" answer per query is unambiguous.
const SEED = [
  "Keeps tax documents in the Documents/Taxes folder",
  "Likes replies kept short and direct, no fluff",
  "Drinks oat-milk flat whites with no sugar",
  "Goes to the gym early, around 6am on weekdays",
  "Stores invoices in Documents/Invoices, named by client",
  "Prefers dark mode in every app",
  "Has a dog named Mochi, a shiba inu",
  "Works as a product manager on an AI platform",
  "Lives in Vancouver, in the Pacific time zone",
  "Allergic to peanuts and shellfish",
  "Uses VS Code with the Vim extension",
  "Books flights through the Aeroplan loyalty program",
  "Reads sci-fi novels, currently into Ted Chiang",
  "Pays rent on the first of every month",
  "Keeps wedding photos in Pictures/Wedding-2024",
  "Speaks English and Telugu at home",
];

// query -> the substring that MUST appear in the #1 retrieved memory.
const CASES: { q: string; expect: string }[] = [
  { q: "where are my tax files?", expect: "Taxes" },
  { q: "remind me to pay rent this week", expect: "rent" },
  { q: "what should I cook that is safe for me to eat?", expect: "Allergic" },
  { q: "help me set up my code editor", expect: "VS Code" },
  { q: "find a photo from my wedding", expect: "wedding photos" },
  { q: "what do I like to drink in the morning?", expect: "flat whites" },
];

function fmt(n: number): string {
  return n.toFixed(3);
}

async function main(): Promise<void> {
  // Empty store → empty block, "all" mode.
  const empty = await store.relevantMemories("anything");
  if (empty !== "") throw new Error(`expected empty block on empty store, got: ${JSON.stringify(empty)}`);
  console.log("✓ empty store → empty injection block");

  for (const s of SEED) await store.addMemory(s, "fact", "memtest");
  console.log(`\nSeeded ${store.listMemories().length} memories.\n`);

  let pass = 0;
  for (const { q, expect } of CASES) {
    const { scored, mode } = await store.rankMemories(q, 5);
    const top = scored[0];
    const ok = !!top && top.text.includes(expect);
    if (ok) pass++;
    console.log(`Q: "${q}"  [mode=${mode}]  ${ok ? "✓" : "✗ EXPECTED to contain: " + JSON.stringify(expect)}`);
    for (const s of scored) {
      const mark = s === top ? "→" : " ";
      console.log(`   ${mark} ${fmt(s.score)}  ${s.text}`);
    }
    console.log("");
    if (mode !== "semantic") throw new Error(`expected semantic mode with 16 memories, got "${mode}"`);
  }

  // Relevance floor: a query unrelated to EVERY memory injects nothing (so an off-topic memory
  // can't bleed into a task — the bug that derailed a small model with "Portland hotel deals").
  const unrelated = await store.rankMemories("explain quantum entanglement in particle physics", 10);
  const floorOk = unrelated.scored.length === 0;
  console.log(`Unrelated query → ${unrelated.scored.length} injected ${floorOk ? "✓ (clean)" : "✗ (expected 0)"}`);

  // --- concurrency: simulate the post-migration window (all embeddings NULL) and fire two
  // retrievals at once. The single-flight backfill must embed once AND re-hydrate BOTH
  // callers' rows — if the non-pass caller kept NULL rows it would score them -1 and rank wrong.
  const wipe = new DatabaseSync(dbPath);
  wipe.exec("UPDATE memories SET embedding = NULL");
  wipe.close(); // release the lock before the store connection reads
  const [a, b] = await Promise.all([
    store.rankMemories("where are my tax files?", 5),
    store.rankMemories("find a photo from my wedding", 5),
  ]);
  const aOk = a.mode === "semantic" && !!a.scored[0]?.text.includes("Taxes");
  const bOk = b.mode === "semantic" && !!b.scored[0]?.text.includes("wedding photos");
  console.log(`Concurrent backfill: tax-query ${aOk ? "✓" : "✗"} (${a.scored[0]?.score.toFixed(3)}), ` +
    `wedding-query ${bOk ? "✓" : "✗"} (${b.scored[0]?.score.toFixed(3)})`);

  const allPass = pass === CASES.length && aOk && bOk && floorOk;
  console.log(`\nRESULT: ${pass}/${CASES.length} ranking + ${aOk && bOk ? "2/2" : "FAILED"} concurrent + relevance-floor ${floorOk ? "✓" : "✗"}.`);
  if (!allPass) process.exitCode = 1;
}

await main().finally(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* temp file — ignore */
  }
});
