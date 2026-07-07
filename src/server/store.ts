// SQLite persistence (Node 24 built-in node:sqlite — no dependency, no native build).
// Stores every run's metadata, full AgentEvent stream (for replay), and the session
// messages (so a conversation can be continued after a server restart).
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "../events.ts";
import type { OpManifest } from "../journal.ts";
import type { RunSummary } from "./runRegistry.ts";
import { embed, embedMany, cosineSimilarity } from "./embed.ts";
import { dbPath } from "../paths.ts";

// One DB per machine. Reused across HMR via globalThis. The path comes from paths.dbPath()
// (ERRAND_DB > ERRAND_DATA-derived > cwd) so tests point at an isolated temp file and an Electron
// host points at userData — read lazily, so the env set just before this import is always honored.
const g = globalThis as unknown as { __errandDb?: DatabaseSync };
const db = (g.__errandDb ??= new DatabaseSync(dbPath()));

// Hot-path durability tuning. The agent fires an appendEvent per non-delta event, and the
// default rollback journal + synchronous=FULL forces a full fsync on each one. WAL collapses
// those into far fewer fsyncs and lets the SSE reader run concurrently with writes;
// synchronous=NORMAL is the safe WAL companion; busy_timeout avoids SQLITE_BUSY when a second
// tab reads while a run writes. Set every process (busy_timeout is per-connection; WAL persists).
try {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 3000");
} catch {
  // A read-only or unusual filesystem may reject WAL; the default journal still works.
}

// Run fn inside a single SQLite transaction so a multi-statement write is all-or-nothing: a
// crash (or a thrown error) mid-way rolls back instead of leaving half-applied rows. node:sqlite
// has no .transaction() helper, so drive BEGIN/COMMIT/ROLLBACK explicitly. NOT re-entrant —
// SQLite has no nested BEGIN; never call tx() from inside another tx().
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ROLLBACK can only fail if no transaction is open (already rolled back) — ignore.
    }
    throw e;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    runId TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    status TEXT NOT NULL,
    roots TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    changeCount INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    runId TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (runId, seq)
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    source TEXT,
    createdAt INTEGER NOT NULL,
    embedding TEXT
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    prompt TEXT,
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal (
    runId TEXT NOT NULL,
    opId TEXT NOT NULL,
    op TEXT NOT NULL,
    description TEXT NOT NULL,
    reversibility TEXT NOT NULL,
    manifest TEXT,
    PRIMARY KEY (runId, opId)
  );
`);

// ---- ordered schema migrations ----
// The baseline CREATE TABLE IF NOT EXISTS above is "the schema a fresh DB gets". Anything that
// can't be expressed idempotently that way — chiefly ALTER TABLE on an EXISTING table — goes
// here as a numbered migration. SQLite's PRAGMA user_version is the durable cursor: each
// migration runs at most once, in order, and bumps the version inside the SAME transaction so a
// crash mid-migration rolls back AND leaves the version unbumped (it re-runs cleanly next boot).
// The durability/resume refactor (turn_state, tool_inflight, runs.resumable) lands as migrations
// 2, 3, … here instead of one-off probes.
function columnExists(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
}

const MIGRATIONS: Array<{ name: string; up: () => void }> = [
  {
    // v1 — embedding column for memories tables created before retrieval existed. Guarded so it
    // is a no-op on a fresh DB (baseline already declares the column) and on the live errand.db
    // (the old ad-hoc probe already added it); only a genuinely pre-embedding DB gets the ALTER.
    name: "memories.embedding",
    up: () => {
      if (!columnExists("memories", "embedding")) {
        db.exec("ALTER TABLE memories ADD COLUMN embedding TEXT");
      }
    },
  },
  {
    // v2 — resumable-runs persistence spine (foundation for resume-mid-flight; no behavior change
    // yet — these objects are written/read by later milestones). `turn_state` is the durable
    // mid-turn checkpoint (one in-flight turn per run): the model's exact messages array plus enough
    // loop state to re-enter send() at the right boundary. `tool_inflight` marks a permanent/unknown
    // tool that was executing at crash time, so resume marks it UNCERTAIN instead of re-running it
    // (the irreversible-double-execution guard). `runs.resumable` flags a run that has a recoverable
    // checkpoint (boot resumes it) vs a legacy zombie (reconcile to interrupted). All additive +
    // idempotent, so this is a no-op shape on a DB that somehow already has them.
    name: "resume.turn_state",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS turn_state (
          runId TEXT PRIMARY KEY,
          turnId TEXT NOT NULL,
          phase TEXT NOT NULL,
          iteration INTEGER NOT NULL,
          callCursor INTEGER NOT NULL DEFAULT 0,
          pendingCallId TEXT,
          messages TEXT NOT NULL,
          callCounts TEXT NOT NULL DEFAULT '{}',
          autoApproveReversible INTEGER NOT NULL DEFAULT 0,
          maxEmittedSeq INTEGER NOT NULL DEFAULT -1,
          updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tool_inflight (
          runId TEXT NOT NULL,
          callId TEXT NOT NULL,
          toolName TEXT NOT NULL,
          reversibility TEXT NOT NULL,
          startedAt INTEGER NOT NULL,
          PRIMARY KEY (runId, callId)
        );
      `);
      if (!columnExists("runs", "resumable")) {
        db.exec("ALTER TABLE runs ADD COLUMN resumable INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    // v3 — persist the journal `undone` flag. It was in-memory only, so an evicted-then-rehydrated
    // run rebuilt every op with undone=false: a second whole-run undo would re-run inverses already
    // applied (re-deleting a folder the user re-created, etc.). Now markJournalOpUndone() persists it
    // and rebuildJournalFromStore() restores it. Additive + idempotent (no-op if the column exists).
    name: "journal.undone",
    up: () => {
      if (!columnExists("journal", "undone")) {
        db.exec("ALTER TABLE journal ADD COLUMN undone INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
];

function userVersion(): number {
  return Number((db.prepare("PRAGMA user_version").get() as any).user_version) || 0;
}

function runMigrations(): void {
  for (let v = userVersion(); v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v];
    tx(() => {
      m.up();
      // user_version is an integer we control (the loop index), not user input — PRAGMA can't be
      // parameterized, so interpolate the validated int. The bump shares the migration's tx.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
runMigrations();

// Expression indexes for the case-insensitive dedup lookups. addMemory/addSuggestion both do
// `WHERE lower(text) = lower(?)`, which can't use a plain text index — so every insert was an
// O(N) full scan, and dreaming inserts in bulk over a monotonically growing store. SQLite
// supports indexes on expressions; these make the dedup probe an index seek.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_memories_lower_text ON memories(lower(text));
  CREATE INDEX IF NOT EXISTS idx_suggestions_lower_text ON suggestions(lower(text));
`);

const stmtCreate = db.prepare(
  `INSERT OR IGNORE INTO runs (runId, title, createdAt, status, roots, updatedAt) VALUES (?, ?, ?, 'working', ?, ?)`,
);
const stmtStatus = db.prepare(`UPDATE runs SET status = ?, updatedAt = ? WHERE runId = ?`);
const stmtChange = db.prepare(`UPDATE runs SET changeCount = ?, updatedAt = ? WHERE runId = ?`);
const stmtMessages = db.prepare(`UPDATE runs SET messages = ?, updatedAt = ? WHERE runId = ?`);
const stmtEvent = db.prepare(`INSERT OR IGNORE INTO events (runId, seq, payload) VALUES (?, ?, ?)`);
const stmtList = db.prepare(
  `SELECT runId, title, createdAt, status, changeCount FROM runs ORDER BY createdAt DESC LIMIT 50`,
);
const stmtEvents = db.prepare(`SELECT payload FROM events WHERE runId = ? ORDER BY seq ASC`);
const stmtMaxSeq = db.prepare(`SELECT MAX(seq) AS m FROM events WHERE runId = ?`);
const stmtRun = db.prepare(`SELECT runId, title, createdAt, roots, messages FROM runs WHERE runId = ?`);
const stmtAddJournal = db.prepare(
  `INSERT OR IGNORE INTO journal (runId, opId, op, description, reversibility, manifest) VALUES (?, ?, ?, ?, ?, ?)`,
);
const stmtJournal = db.prepare(
  `SELECT opId, op, description, reversibility, manifest, undone FROM journal WHERE runId = ? ORDER BY rowid ASC`,
);
const stmtMarkUndone = db.prepare(`UPDATE journal SET undone = 1 WHERE runId = ? AND opId = ?`);
const stmtSaveTurn = db.prepare(
  `INSERT OR REPLACE INTO turn_state
     (runId, turnId, phase, iteration, callCursor, pendingCallId, messages, callCounts, autoApproveReversible, maxEmittedSeq, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const stmtGetTurn = db.prepare(`SELECT * FROM turn_state WHERE runId = ?`);
const stmtClearTurn = db.prepare(`DELETE FROM turn_state WHERE runId = ?`);
const stmtSaveInflight = db.prepare(
  `INSERT OR REPLACE INTO tool_inflight (runId, callId, toolName, reversibility, startedAt) VALUES (?, ?, ?, ?, ?)`,
);
const stmtGetInflight = db.prepare(`SELECT callId FROM tool_inflight WHERE runId = ?`);
const stmtClearInflightCall = db.prepare(`DELETE FROM tool_inflight WHERE runId = ? AND callId = ?`);
const stmtClearInflightRun = db.prepare(`DELETE FROM tool_inflight WHERE runId = ?`);

export function createRun(runId: string, title: string, createdAt: number, roots: string[]): void {
  stmtCreate.run(runId, title, createdAt, JSON.stringify(roots), Date.now());
}
export function setStatus(runId: string, status: RunSummary["status"]): void {
  stmtStatus.run(status, Date.now(), runId);
}
export function setChangeCount(runId: string, n: number): void {
  stmtChange.run(n, Date.now(), runId);
}
export function setMessages(runId: string, messages: unknown): void {
  stmtMessages.run(JSON.stringify(messages), Date.now(), runId);
}
export function appendEvent(runId: string, e: AgentEvent): void {
  stmtEvent.run(runId, e.seq, JSON.stringify(e));
}

export function listRunSummaries(): RunSummary[] {
  return (stmtList.all() as any[]).map((r) => ({
    runId: r.runId,
    title: r.title,
    createdAt: r.createdAt,
    status: r.status,
    changeCount: r.changeCount,
  }));
}

// Parse persisted JSON without ever throwing: a single truncated/corrupt blob (a crash
// mid-write, a disk glitch) must degrade gracefully, not take down a route or block boot.
function safeParse<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function getEvents(runId: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const r of stmtEvents.all(runId) as any[]) {
    const e = safeParse<AgentEvent | null>(r.payload, null);
    if (e) out.push(e);
    else console.warn(`[store] skipping unparseable event for run ${runId}`);
  }
  return out;
}

// ---- journal manifest (so Undo survives a restart / a run falling out of memory) ----
// A serializable record of each reversible op a run performed, enough to RECONSTRUCT its
// inverse after the in-memory Journal (with its live closures) is gone. The live path still
// uses the in-memory closures; this is the restart fallback. INSERT OR IGNORE keyed by
// (runId, opId) makes re-persisting a run's journal each turn idempotent.
export interface JournalOp {
  opId: string;
  op: string;
  description: string;
  reversibility: string;
  manifest: OpManifest | null; // parsed back from JSON; null if absent/corrupt
  undone: boolean; // persisted whole-run-undo state — a rehydrated run must not re-run this inverse
}

export function appendJournalOp(
  runId: string,
  rec: { opId: string; op: string; description: string; reversibility: string; manifest?: OpManifest | null },
): void {
  stmtAddJournal.run(
    runId,
    rec.opId,
    rec.op,
    rec.description,
    rec.reversibility,
    rec.manifest != null ? JSON.stringify(rec.manifest) : null,
  );
}

export function getJournalOps(runId: string): JournalOp[] {
  return (stmtJournal.all(runId) as any[]).map((r) => ({
    opId: r.opId,
    op: r.op,
    description: r.description,
    reversibility: r.reversibility,
    manifest: safeParse<OpManifest | null>(r.manifest, null),
    undone: !!r.undone,
  }));
}

// Persist that a whole-run undo successfully reversed this op, so a rehydrated run's rebuilt journal
// won't re-run its inverse (the stale-undo re-delete guard). Idempotent — setting undone=1 twice is a
// no-op. Keyed by (runId, opId) like appendJournalOp.
export function markJournalOpUndone(runId: string, opId: string): void {
  stmtMarkUndone.run(runId, opId);
}

// Permanently remove a run and its full event stream (user clears it from Recently). All the
// deletes commit together so a crash can't orphan events/journal/turn_state rows under a vanished run.
export function deleteRun(runId: string): void {
  tx(() => {
    db.prepare("DELETE FROM events WHERE runId = ?").run(runId);
    db.prepare("DELETE FROM journal WHERE runId = ?").run(runId);
    db.prepare("DELETE FROM turn_state WHERE runId = ?").run(runId);
    db.prepare("DELETE FROM tool_inflight WHERE runId = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE runId = ?").run(runId);
  });
}

export function getStoredRun(
  runId: string,
): { runId: string; title: string; createdAt: number; roots: string[]; messages: any[] } | null {
  const r = stmtRun.get(runId) as any;
  if (!r) return null;
  return {
    runId: r.runId,
    title: r.title,
    createdAt: r.createdAt,
    roots: safeParse<string[]>(r.roots, []),
    messages: safeParse<any[]>(r.messages, []),
  };
}

// ---- turn_state (the durable mid-turn checkpoint — see loop.ts TurnState) ----
// One in-flight turn per run, so keyed by runId (INSERT OR REPLACE overwrites the prior checkpoint).
// Written continuously during a turn (so mid-turn state survives a crash) and cleared at turn-settle
// — the durable record of a SETTLED turn lives in runs.messages + events; turn_state is in-flight scratch.
export interface TurnStateRow {
  turnId: string;
  phase: string;
  iteration: number;
  callCursor: number;
  pendingCallId: string | null;
  messages: any[]; // already 400-safe (backfilled) by the caller
  callCounts: Record<string, number>;
  autoApproveReversible: boolean;
  maxEmittedSeq: number;
}

export function saveTurnState(runId: string, s: TurnStateRow): void {
  stmtSaveTurn.run(
    runId,
    s.turnId,
    s.phase,
    s.iteration,
    s.callCursor,
    s.pendingCallId ?? null,
    JSON.stringify(s.messages),
    JSON.stringify(s.callCounts ?? {}),
    s.autoApproveReversible ? 1 : 0,
    s.maxEmittedSeq,
    Date.now(),
  );
}

export function getTurnState(runId: string): TurnStateRow | null {
  const r = stmtGetTurn.get(runId) as any;
  if (!r) return null;
  return {
    turnId: r.turnId,
    phase: r.phase,
    iteration: r.iteration,
    callCursor: r.callCursor,
    pendingCallId: r.pendingCallId ?? null,
    messages: safeParse<any[]>(r.messages, []),
    callCounts: safeParse<Record<string, number>>(r.callCounts, {}),
    autoApproveReversible: !!r.autoApproveReversible,
    maxEmittedSeq: r.maxEmittedSeq,
  };
}

export function clearTurnState(runId: string): void {
  stmtClearTurn.run(runId);
}

// ---- tool_inflight (the irreversible-double-execution guard) ----
// A permanent/unknown tool marks itself IN-FLIGHT the instant before it runs and clears the marker the
// instant after. If the process is killed in that window, the marker survives: on resume the loop sees
// the call was already executing and marks it UNCERTAIN instead of re-running it — so a crash can never
// double-send an email / re-charge a card. Reversible tools are NOT marked (re-running them is safe).
export function saveInflight(runId: string, callId: string, toolName: string, reversibility: string): void {
  stmtSaveInflight.run(runId, callId, toolName, reversibility, Date.now());
}
export function getInflightIds(runId: string): Set<string> {
  return new Set((stmtGetInflight.all(runId) as any[]).map((r) => r.callId as string));
}
export function clearInflight(runId: string, callId: string): void {
  stmtClearInflightCall.run(runId, callId);
}
export function clearInflightForRun(runId: string): void {
  stmtClearInflightRun.run(runId);
}

// A run is RESUMABLE if it's still 'working' AND has a durable mid-turn checkpoint. Such a run is a
// zombie in memory (its loop died with the process) but is NOT a legacy dead-end: rehydrate() can
// re-enter its loop from the checkpoint. reconcileOrphans leaves these alone (so the checkpoint
// survives for lazy resume-on-access); it only force-stops working runs that have NO checkpoint.
export function isResumable(runId: string): boolean {
  const r = db.prepare("SELECT status FROM runs WHERE runId = ?").get(runId) as any;
  if (!r || r.status !== "working") return false;
  return getTurnState(runId) !== null;
}

// ---- restart reconciliation ----
// Any run still 'working' in the DB after a process restart is a zombie: its in-memory loop
// was killed, so it will never finish on its own and would hang the UI (a stuck "working"
// spinner, or a parked approval card whose Approve/Deny buttons are dead because the
// promise they'd resolve is gone). For each such run we (1) resolve every unresolved
// approval to "cancelled" so the card clears, (2) append one calm terminal "interrupted"
// event so the Run View settles, and (3) mark it 'stopped'. The user can reopen it and pick
// up with a new message. Called ONCE per process at boot; `liveIds` (runs currently
// executing in memory — empty at a true boot) are never touched.
export function reconcileOrphans(liveIds: Set<string> = new Set()): number {
  // Leave RESUMABLE runs (a working run with a durable checkpoint) untouched: they are re-entered by
  // rehydrate() on next access (a reconnecting SSE stream, a /message, a /decision), which re-parks any
  // pending approval and continues the loop. Only a working run with NO checkpoint is a true dead-end
  // that must be force-stopped here (its parked approval buttons are dead and it can't be resumed).
  const orphans = (db.prepare("SELECT runId FROM runs WHERE status = 'working'").all() as any[])
    .map((r) => r.runId as string)
    .filter((id) => !liveIds.has(id) && !isResumable(id));
  for (const runId of orphans) {
    const events = getEvents(runId);
    const turnId = "interrupted";
    const resolved = new Set<string>();
    for (const e of events) if (e.type === "approval.resolved") resolved.add(e.callId);
    // One run's reconciliation is all-or-nothing: cancelling its open approvals, appending the
    // terminal "interrupted" event, and flipping status to 'stopped' commit together, so a crash
    // mid-reconcile can't leave a run half-tidied and still 'working' for the next boot to redo.
    tx(() => {
      // Cursor from the actual table (MAX), NOT events[last].seq: getEvents() drops corrupt/unparseable
      // rows (the very failure this durability work guards against), so if the highest-seq row is
      // corrupt, the parsed-list cursor would reuse an occupied (runId, seq) PRIMARY KEY and
      // appendEvent's INSERT OR IGNORE would silently drop the reconcile event — leaving the approval
      // card uncancelled. MAX(seq) sits above corrupt rows too, so the all-or-nothing tx truly completes.
      const m = (stmtMaxSeq.get(runId) as any)?.m;
      let seq = (typeof m === "number" ? m : -1) + 1;
      for (const e of events) {
        if (e.type === "approval.required" && !resolved.has(e.callId)) {
          appendEvent(runId, {
            runId,
            turnId,
            seq: seq++,
            ts: Date.now(),
            type: "approval.resolved",
            callId: e.callId,
            decision: "cancelled",
          });
        }
      }
      appendEvent(runId, {
        runId,
        turnId,
        seq: seq++,
        ts: Date.now(),
        type: "run.error",
        kind: "cancelled",
        userMessage: "This task was interrupted when the app restarted. Send a message to pick up where it left off.",
        recoverable: true,
      });
      setStatus(runId, "stopped");
      // Drop the zombie's mid-turn checkpoint atomically with settling it: this run is now 'stopped'
      // and must NOT be resumed from a stale turn_state. (Resume safety — see the Phase 3b review;
      // the resume consumer will also ignore any turn_state whose run isn't actively 'working'.)
      clearTurnState(runId);
    });
  }
  return orphans.length;
}

// ---- memories ----
export interface Memory {
  id: string;
  text: string;
  kind: string; // preference | fact | pattern
  source: string | null;
  createdAt: number;
}

// Most memories to inject for one task (a ceiling, not a target — the floor below usually keeps it smaller).
const EMBED_TOP_K = 10;
// Minimum cosine similarity to inject a memory at all. Memories UNRELATED to the task (e.g.
// "Portland hotel deals" for a YouTube request) score well below this and are dropped, so an
// off-topic memory can't bleed into the conversation — which especially derails small models.
const RELEVANCE_FLOOR = 0.3;

export async function addMemory(text: string, kind = "fact", source: string | null = null): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";
  // Skip exact duplicates so live-saving + dreaming don't pile up the same fact.
  const existing = db.prepare("SELECT id FROM memories WHERE lower(text) = lower(?)").get(trimmed) as any;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  // Embed at write time so retrieval is fast later; null on failure → backfilled lazily.
  const vec = await embed(trimmed);
  db.prepare("INSERT INTO memories (id, text, kind, source, createdAt, embedding) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    trimmed,
    kind,
    source,
    Date.now(),
    vec ? JSON.stringify(vec) : null,
  );
  return id;
}

// Public list — NEVER selects the embedding column (it's a 1536-float blob; the UI/API
// don't need it and shouldn't pay to serialize it).
export function listMemories(): Memory[] {
  return db
    .prepare("SELECT id, text, kind, source, createdAt FROM memories ORDER BY createdAt DESC")
    .all() as unknown as Memory[];
}

export function deleteMemory(id: string): void {
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export async function updateMemory(id: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  // Re-embed: the text changed, so the old vector is stale.
  const vec = await embed(trimmed);
  db.prepare("UPDATE memories SET text = ?, embedding = ? WHERE id = ?").run(trimmed, vec ? JSON.stringify(vec) : null, id);
}

// ---- relevance-filtered retrieval (replaces the old full-dump injection) ----
interface MemoryRow extends Memory {
  embedding: number[] | null;
}

function parseEmbedding(raw: unknown): number[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length ? (v as number[]) : null;
  } catch {
    return null;
  }
}

// Internal: rows WITH their parsed embeddings, newest first. Only retrieval uses this.
function listMemoryRows(): MemoryRow[] {
  const rows = db
    .prepare("SELECT id, text, kind, source, createdAt, embedding FROM memories ORDER BY createdAt DESC")
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    kind: r.kind,
    source: r.source,
    createdAt: r.createdAt,
    embedding: parseEmbedding(r.embedding),
  }));
}

// One shared backfill at a time: two runs starting at once (two tabs, a double-click) would
// otherwise each fire embedMany for the same NULL-embedding rows during the brief
// post-migration window. We single-flight the embed+persist, then every caller re-hydrates
// its OWN rows from the now-persisted DB (so the caller that didn't run the pass still gets
// the vectors — skipping instead would leave its rows NULL and score them -1).
let backfillInFlight: Promise<void> | null = null;

// Backfill embeddings for any rows missing one (rows from before the migration, or where a
// write-time embed failed). Persisted, so it self-heals after the first retrieval. Mutates
// the passed rows in place. Fast path returns with no await when nothing is missing.
async function backfillEmbeddings(rows: MemoryRow[]): Promise<void> {
  if (rows.every((r) => r.embedding)) return;
  if (!backfillInFlight) {
    backfillInFlight = (async () => {
      // Re-read inside the shared pass so we embed the freshest NULL set, not a stale snapshot.
      const fresh = listMemoryRows().filter((r) => !r.embedding);
      if (!fresh.length) return;
      const vecs = await embedMany(fresh.map((m) => m.text));
      const upd = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
      fresh.forEach((m, i) => {
        const v = vecs[i];
        if (v) upd.run(JSON.stringify(v), m.id);
      });
    })().finally(() => {
      backfillInFlight = null;
    });
  }
  await backfillInFlight;
  // Re-hydrate this caller's rows from the persisted result (works whether or not we ran the pass).
  const read = db.prepare("SELECT embedding FROM memories WHERE id = ?");
  for (const r of rows) {
    if (!r.embedding) r.embedding = parseEmbedding((read.get(r.id) as any)?.embedding);
  }
}

export interface ScoredMemory {
  id: string;
  text: string;
  score: number;
}

// Core retrieval. Embeds the task and returns ONLY the memories genuinely related to it
// (cosine ≥ RELEVANCE_FLOOR), newest-relevant first, capped at k. Critically this runs for
// EVERY size of memory set — there is no "inject them all when small" shortcut, because that
// is exactly what let an off-topic memory bleed in. `mode` says why:
//   - "semantic": embedded + cosine-filtered (the normal path; may legitimately return none)
//   - "recency":  embedding the query failed → newest-first fallback so memory still works offline
export async function rankMemories(
  query: string,
  k = EMBED_TOP_K,
): Promise<{ scored: ScoredMemory[]; mode: "recency" | "semantic" }> {
  const rows = listMemoryRows(); // newest first
  if (!rows.length) return { scored: [], mode: "semantic" };
  await backfillEmbeddings(rows);
  const qvec = await embed(query);
  if (!qvec) {
    // Embedding outage: fall back to a few most-recent so memory isn't silently lost.
    return { scored: rows.slice(0, k).map((m) => ({ id: m.id, text: m.text, score: 0 })), mode: "recency" };
  }
  const scored = rows
    .map((m) => ({ id: m.id, text: m.text, score: m.embedding ? cosineSimilarity(qvec, m.embedding) : -1 }))
    .filter((s) => s.score >= RELEVANCE_FLOOR) // drop anything not actually related to THIS task
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return { scored, mode: "semantic" };
}

// Relevance-filtered block injected into the system prompt for THIS task — only the
// memories closest to the request, not every memory ever saved.
export async function relevantMemories(query: string, k = EMBED_TOP_K): Promise<string> {
  const { scored } = await rankMemories(query, k);
  return scored.map((s) => `- ${s.text}`).join("\n");
}

// ---- proactive suggestions (from dreaming) ----
export interface Suggestion {
  id: string;
  text: string;
  prompt: string | null; // a ready-to-run errand if the user taps it
  createdAt: number;
}

const MAX_SUGGESTIONS = 3;

export function addSuggestion(text: string, prompt: string | null = null): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const existing = db.prepare("SELECT id FROM suggestions WHERE lower(text) = lower(?)").get(trimmed) as any;
  if (existing) return;
  db.prepare("INSERT INTO suggestions (id, text, prompt, createdAt) VALUES (?, ?, ?, ?)").run(
    crypto.randomUUID(),
    trimmed,
    prompt,
    Date.now(),
  );
  // Keep only the newest few — the freshest ideas are the most relevant.
  db.prepare(
    "DELETE FROM suggestions WHERE id NOT IN (SELECT id FROM suggestions ORDER BY createdAt DESC LIMIT ?)",
  ).run(MAX_SUGGESTIONS);
}

export function listSuggestions(): Suggestion[] {
  return db
    .prepare("SELECT * FROM suggestions ORDER BY createdAt DESC LIMIT ?")
    .all(MAX_SUGGESTIONS) as unknown as Suggestion[];
}

export function deleteSuggestion(id: string): void {
  db.prepare("DELETE FROM suggestions WHERE id = ?").run(id);
}

// Recent conversations (user + assistant turns) flattened for the dreaming pass to reflect on.
export function recentConversations(limitRuns = 8): string {
  const rows = db
    .prepare("SELECT title, messages FROM runs ORDER BY createdAt DESC LIMIT ?")
    .all(limitRuns) as any[];
  const parts: string[] = [];
  for (const r of rows) {
    let msgs: any[];
    try {
      msgs = JSON.parse(r.messages);
    } catch {
      continue;
    }
    const convo = msgs
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => `${m.role === "user" ? "User" : "Errand"}: ${m.content}`)
      .join("\n");
    if (convo) parts.push(convo);
  }
  return parts.join("\n---\n").slice(0, 12000);
}

// ---- settings (key/value) ----
export function getSetting(key: string, fallback = ""): string {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return r ? r.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}
