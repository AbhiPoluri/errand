// Store write-side suite (rank 18) — isolated ERRAND_DB, embeddings forced fail-soft (offline
// via the embed stub seam). Asserts the durability/idempotency rules that keep dreaming +
// live-saving from piling up duplicates and suggestions from growing unbounded — pure SQLite
// logic, zero credentials. memtest only covers the embedding-ranking path.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dbPath = join(tmpdir(), `errand-storetest-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // MUST be set before store.ts opens the DB
const store = await import("./server/store.ts");
const { _setEmbedClient } = await import("./server/embed.ts");
// Force embeddings offline: every embed() call returns null (fail-soft), no network.
_setEmbedClient({
  embeddings: {
    create: async () => {
      throw new Error("offline");
    },
  },
});

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testMemories() {
  console.log("\n== memories: dedup, blank no-op, no embedding leak ==");
  const id1 = await store.addMemory("Likes Tea");
  const id2 = await store.addMemory("likes tea"); // differs only by case
  check("case-insensitive dedup returns the SAME id", id1 === id2 && id1 !== "");
  const blank = await store.addMemory("   ");
  check("blank addMemory returns '' ", blank === "");
  check("blank/dup inserted nothing (1 memory total)", store.listMemories().length === 1);

  await store.updateMemory(id1, "Loves Coffee");
  check("updateMemory changes the text", store.listMemories().find((m) => m.id === id1)?.text === "Loves Coffee");
  await store.updateMemory(id1, "   ");
  check("updateMemory blank is a no-op", store.listMemories().find((m) => m.id === id1)?.text === "Loves Coffee");

  const row = store.listMemories()[0] as any;
  check("listMemories never exposes the embedding column", !("embedding" in row));

  store.deleteMemory(id1);
  check("deleteMemory removes the row", !store.listMemories().some((m) => m.id === id1));
}

async function testSuggestions() {
  console.log("\n== suggestions: dedup + cap to newest MAX_SUGGESTIONS ==");
  // distinct createdAt so "newest" is deterministic (cap orders by createdAt DESC).
  store.addSuggestion("Idea A");
  store.addSuggestion("idea a"); // dup by lowercased text
  check("dedup by lowercased text", store.listSuggestions().length === 1);
  await sleep(3);
  store.addSuggestion("Idea B");
  await sleep(3);
  store.addSuggestion("Idea C");
  await sleep(3);
  store.addSuggestion("Idea D"); // 4 distinct now -> capped to 3 newest
  const sugs = store.listSuggestions();
  check("capped to 3 (MAX_SUGGESTIONS)", sugs.length === 3, `${sugs.length}`);
  check("oldest (Idea A) was evicted", !sugs.some((s) => s.text === "Idea A"));
  check("newest (Idea D) is kept", sugs.some((s) => s.text === "Idea D"));
}

function testSettings() {
  console.log("\n== settings: round-trip + fallback ==");
  check("absent key returns the fallback", store.getSetting("nope", "fallback") === "fallback");
  store.setSetting("k", "v1");
  check("round-trip", store.getSetting("k") === "v1");
  store.setSetting("k", "v2");
  check("INSERT OR REPLACE overwrites", store.getSetting("k") === "v2");
}

function testDedupIndexes() {
  console.log("\n== dedup lookups use an index (not a full scan) ==");
  const raw = new DatabaseSync(dbPath);
  const plan = (sql: string) => (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as any[]).map((r) => r.detail).join(" | ");
  const memPlan = plan("SELECT id FROM memories WHERE lower(text) = lower('x')");
  const sugPlan = plan("SELECT id FROM suggestions WHERE lower(text) = lower('x')");
  raw.close();
  check("memories dedup uses an index", /USING INDEX/i.test(memPlan), memPlan);
  check("suggestions dedup uses an index", /USING INDEX/i.test(sugPlan), sugPlan);
}

function testRecentConversationsSkipsMalformed() {
  console.log("\n== recentConversations skips a malformed messages row (no throw) ==");
  store.createRun("badrun", "Bad", 2, ["/tmp"]);
  store.createRun("goodrun", "Good", 1, ["/tmp"]);
  store.setMessages("goodrun", [{ role: "user", content: "hello there friend" }]);
  // Inject invalid JSON directly (setMessages always stringifies, so it can't produce this).
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE runs SET messages = ? WHERE runId = ?").run("{not valid json", "badrun");
  raw.close();
  const convos = store.recentConversations(8);
  check("did not throw and included the good run", convos.includes("hello there friend"));
  check("the malformed run contributed nothing", !convos.includes("{not valid json"));
}

function testJournalOpManifest() {
  console.log("\n== journal op: null manifest round-trips + a corrupt blob degrades to null (no throw) ==");
  store.createRun("jrun", "Journal run", 1, ["/tmp"]);
  store.appendJournalOp("jrun", { opId: "op-null", op: "run_command", description: "no manifest", reversibility: "unknown", manifest: null });
  store.appendJournalOp("jrun", { opId: "op-ok", op: "move", description: "a move", reversibility: "reversible", manifest: { kind: "move", from: "/a", to: "/b" } as any });
  // Corrupt the second op's manifest blob directly (appendJournalOp always stringifies valid JSON).
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE journal SET manifest = ? WHERE runId = ? AND opId = ?").run("{not json", "jrun", "op-ok");
  raw.close();
  const ops = store.getJournalOps("jrun");
  check("both journal ops returned (no throw)", ops.length === 2, `${ops.length}`);
  check("a null manifest round-trips as null", ops.find((o) => o.opId === "op-null")?.manifest === null);
  const corrupt = ops.find((o) => o.opId === "op-ok");
  check("a corrupt manifest blob degrades to null (safeParse, no throw)", !!corrupt && corrupt.manifest === null);
  check("the corrupt op's other fields are intact", corrupt?.op === "move" && corrupt?.description === "a move");
}

function testGetEventsSkipsCorrupt() {
  console.log("\n== getEvents skips an unparseable event row (reconcileOrphans relies on this) ==");
  store.createRun("erun", "Event run", 1, ["/tmp"]);
  store.appendEvent("erun", { runId: "erun", turnId: "t", seq: 0, ts: 1, type: "run.started", title: "x" } as any);
  store.appendEvent("erun", { runId: "erun", turnId: "t", seq: 1, ts: 1, type: "user.message", text: "hi" } as any);
  store.appendEvent("erun", { runId: "erun", turnId: "t", seq: 2, ts: 1, type: "run.finished", status: "completed" } as any);
  // Corrupt the MIDDLE event's payload directly (appendEvent always stringifies a valid event).
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE events SET payload = ? WHERE runId = ? AND seq = ?").run("{bad", "erun", 1);
  raw.close();
  const evs = store.getEvents("erun") as any[];
  check("returns the 2 good events, skips the corrupt one (no throw)", evs.length === 2, `${evs.length}`);
  check("the surviving events are the good ones (not the corrupt middle)", evs.some((e) => e.type === "run.started") && evs.some((e) => e.type === "run.finished"));
}

async function main() {
  await testMemories();
  await testSuggestions();
  testSettings();
  testDedupIndexes();
  testRecentConversationsSkipsMalformed();
  testJournalOpManifest();
  testGetEventsSkipsCorrupt();
  _setEmbedClient(null);
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main().finally(() => {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  } catch {
    /* temp files — ignore */
  }
});
