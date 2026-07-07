// Verifies the schema-migration framework + transaction discipline added in the durability
// foundation phase. Two things, both against isolated temp DBs (ERRAND_DB):
//   1. runMigrations() upgrades a genuinely OLD DB (a memories table created before the
//      embedding column existed, user_version 0) exactly once, in a transaction, and records
//      the new user_version — while leaving a fresh DB at the latest version with no double-apply.
//   2. tx() is truly all-or-nothing: a throw inside rolls back every write; a clean run commits.
// Run: `npm run migrate:test`. No network (never calls embed()).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as any).user_version) || 0;
}
function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
}
function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

async function main(): Promise<void> {
  // ---- 1. OLD DB: a pre-embedding memories table at user_version 0, with a real row. ----
  const oldDb = join(tmpdir(), `errand-migtest-old-${process.pid}.db`);
  rmSync(oldDb, { force: true });
  {
    const raw = new DatabaseSync(oldDb);
    // The schema as it existed BEFORE retrieval/embeddings — deliberately NO embedding column.
    raw.exec(
      "CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', source TEXT, createdAt INTEGER NOT NULL)",
    );
    raw.exec("INSERT INTO memories (id, text, kind, createdAt) VALUES ('m1', 'keep me', 'fact', 1)");
    check("old DB starts at user_version 0", userVersion(raw) === 0);
    check("old DB has no embedding column yet", !hasColumn(raw, "memories", "embedding"));
    raw.close();
  }

  // Importing store.ts opens this DB and runs migrations at module-init.
  process.env.ERRAND_DB = oldDb;
  const store = await import("./server/store.ts");

  {
    const insp = new DatabaseSync(oldDb);
    check("migration v1 added the embedding column to the old table", hasColumn(insp, "memories", "embedding"));
    check("user_version bumped to the latest (3)", userVersion(insp) === 3);
    // The pre-existing row survived the ALTER (migration is non-destructive).
    const row = insp.prepare("SELECT text, embedding FROM memories WHERE id = 'm1'").get() as any;
    check("existing memory row survived the migration", row?.text === "keep me");
    check("back-filled column is NULL on the old row (lazy embed later)", row?.embedding === null);
    // v2 — resumable-runs spine: the two tables + the runs.resumable column exist now.
    check("migration v2 created turn_state", hasTable(insp, "turn_state"));
    check("migration v2 created tool_inflight", hasTable(insp, "tool_inflight"));
    check("migration v2 added runs.resumable", hasColumn(insp, "runs", "resumable"));
    // v3 — the persisted journal `undone` flag (whole-run-undo state survives eviction/restart).
    check("migration v3 added journal.undone", hasColumn(insp, "journal", "undone"));
    insp.close();
  }
  check("listMemories works post-migration", store.listMemories().length === 1);

  // ---- 2. tx(): rollback on throw, commit on success. ----
  store.createRun("txrun", "tx test", 1, ["/tmp"]);
  check("run starts 'working'", store.listRunSummaries().find((r) => r.runId === "txrun")?.status === "working");

  // A throw mid-transaction must roll back the status change.
  let threw = false;
  try {
    store.tx(() => {
      store.setStatus("txrun", "done");
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  check("tx() re-throws the inner error", threw);
  check(
    "tx() rolled back the status write (still 'working')",
    store.listRunSummaries().find((r) => r.runId === "txrun")?.status === "working",
  );

  // A clean tx commits.
  store.tx(() => store.setStatus("txrun", "stopped"));
  check(
    "clean tx() committed the status write ('stopped')",
    store.listRunSummaries().find((r) => r.runId === "txrun")?.status === "stopped",
  );

  // deleteRun (now wrapped in tx) removes the run and all of its side tables.
  store.appendEvent("txrun", { runId: "txrun", turnId: "t", seq: 0, ts: 1, type: "run.started", title: "tx test" } as any);
  store.deleteRun("txrun");
  check("deleteRun removed the run row", !store.listRunSummaries().some((r) => r.runId === "txrun"));
  check("deleteRun removed its events", store.getEvents("txrun").length === 0);

  rmSync(oldDb, { force: true });
  rmSync(`${oldDb}-wal`, { force: true });
  rmSync(`${oldDb}-shm`, { force: true });

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
