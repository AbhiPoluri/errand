// In-memory run registry (the v1 hosting seam — see PLAN.md open risks). Holds each
// live run so the SSE stream, /decision, /cancel, and /message endpoints can reach the
// parked loop. Stored on globalThis so Next.js dev HMR doesn't drop live runs.
import { config } from "../config.ts";
import { Session } from "../session.ts";
import { Journal } from "../journal.ts";
import { Logger } from "../log.ts";
import { Registry } from "../tools/index.ts";
import { buildRegistryFor, enabledPacks } from "../capabilities/index.ts";
import { makeClient } from "../client.ts";
import { ENDPOINTS, DEFAULT_OLLAMA_BASE_URL, normalizeOllamaBaseUrl, modelSupportsVision } from "../models.ts";
import { AgentRunner } from "../loop.ts";
import { type ApprovalGate, type ApprovalRequest, type Decision } from "../approvals.ts";
import { SYSTEM_PROMPT } from "../prompt.ts";
import { WebSink } from "./webSink.ts";
import * as store from "./store.ts";
import { dream } from "./dream.ts";
import { rebuildJournalFromStore } from "./journalRestore.ts";
import { McpManager } from "./mcp/manager.ts";
import { loadMcpServers } from "./mcp/config.ts";
import { skillsSummary } from "./skills.ts";

// Reflect after a task settles — only if dreaming is on, debounced so it doesn't run
// after every turn. Fire-and-forget; failures are silent.
let dreamingNow = false;
function maybeDream(): void {
  if (store.getSetting("dreaming") !== "on" || dreamingNow) return;
  if (Date.now() - Number(store.getSetting("lastDream") || "0") < 90_000) return;
  dreamingNow = true;
  dream()
    .catch(() => {})
    .finally(() => {
      dreamingNow = false;
    });
}

interface RunEntry {
  runId: string;
  session: Session;
  runner: AgentRunner;
  sink: WebSink;
  abort: AbortController;
  pending: Map<string, (d: Decision) => void>;
  busy: boolean;
  autoApproveReversible: boolean; // "Yes to all (this errand)" — REVERSIBLE actions only
  title: string; // first message, for the Recently list
  createdAt: number;
  deleted?: boolean; // user removed it mid-run — stop persisting its in-flight events
  // Serializes turns on this run. Each turn chains onto the previous one's settled promise, so two
  // runner.send() calls can NEVER execute concurrently on the one shared Session (its messages
  // array) — even when an interrupted turn's tool ignores the abort signal and keeps running. This
  // replaces the old "abort, wait up to 5s, then start the next turn regardless" race.
  turnQueue: Promise<void>;
  // Monotonic count of turns ever enqueued, and the highest turn id that has been cancelled. A
  // queued turn is skipped before it starts when its id <= cancelledThrough — so a Stop that lands
  // while a follow-up turn is still QUEUED (behind a turn whose tool is ignoring abort) cancels
  // that queued turn too, instead of letting it run to completion the moment the one ahead settles.
  turnSeq: number;
  cancelledThrough: number;
}

export interface RunSummary {
  runId: string;
  title: string;
  createdAt: number;
  status: "working" | "done" | "stopped";
  changeCount: number;
}

// Each run gets a gate that parks the approval promise in the entry; /decision resolves it.
class WebGate implements ApprovalGate {
  constructor(private entry: RunEntry) {}
  // The loop only consults this for reversible requests; permanent/unknown always pause.
  autoApproves(_req: ApprovalRequest): boolean {
    return this.entry.autoApproveReversible;
  }
  request(req: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      if (signal.aborted) return resolve("cancelled");
      const finish = (d: Decision) => {
        signal.removeEventListener("abort", onAbort);
        this.entry.pending.delete(req.callId);
        resolve(d);
      };
      const onAbort = () => finish("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      this.entry.pending.set(req.callId, finish);
    });
  }
}

const g = globalThis as unknown as {
  __errandRuns?: Map<string, RunEntry>;
  __errandReconciled?: boolean;
  __errandMcp?: McpManager;
  __errandMcpConfigured?: boolean;
};
const runs: Map<string, RunEntry> = (g.__errandRuns ??= new Map());

// MCP manager singleton (persistent server connections, survives HMR). Configured once per process
// from the saved server list; its tools are appended to every run's registry in buildRegistry().
const mcpManager: McpManager = (g.__errandMcp ??= new McpManager());
export function getMcpManager(): McpManager {
  return mcpManager;
}
if (!g.__errandMcpConfigured) {
  g.__errandMcpConfigured = true;
  // Fire-and-forget: warm up connections to enabled servers at boot. A run that starts before a
  // server finishes connecting simply won't see its tools yet (the next run will) — never blocks boot.
  mcpManager.configure(loadMcpServers()).catch((e) => console.warn("[errand] MCP initial configure failed:", e));
}

// Once per process (NOT per HMR re-eval — the flag lives on globalThis): any run the DB still
// calls 'working' is a zombie from a killed process. Reconcile it to an interrupted state so
// it never hangs the UI. `runs` is empty at a true boot; passing its keys is belt-and-braces
// so an HMR edge can never mark a genuinely-live run as interrupted.
if (!g.__errandReconciled) {
  g.__errandReconciled = true;
  // This runs at module-init time, before any route can serve — so a throw here would brick
  // EVERY /api/runs/* route at boot. Guard it: a reconcile failure must degrade to "didn't
  // tidy up the zombies", never "the server won't start".
  try {
    const n = store.reconcileOrphans(new Set(runs.keys()));
    if (n) console.log(`[errand] reconciled ${n} interrupted run(s) from a previous session`);
  } catch (e) {
    console.warn("[errand] orphan reconciliation failed (continuing):", e);
  }
}

function buildRegistry(): Registry {
  // The packs the user has enabled in Settings (defaults to the no-auth consumer surface
  // files/web/browser/memory; 'files' always forced on). General `bash` is the "power path"
  // (decision #4) and is intentionally NOT in any web pack yet.
  const reg = buildRegistryFor(enabledPacks(store.getSetting("packs")));
  // Overlay tools from any connected MCP servers (each is gated + unknown-reversibility, so they
  // flow through the same approval path). Connected servers only; a down server adds nothing.
  for (const t of mcpManager.getTools()) reg.register(t);
  return reg;
}

// The model new runs use: the user's saved choice (Settings → model switcher) or the env
// default. Read per-run so switching the model takes effect on the next run, no restart.
function currentModel(): string {
  return store.getSetting("model", config.model);
}

// Whether to feed page screenshots to the model on browser tasks ("eyes"): on unless the user turned
// it off in Settings AND only when the selected model can actually read images (else it's wasted /
// errors). Read per-run so a model/toggle change takes effect next run.
function currentVision(): boolean {
  return store.getSetting("vision", "on") !== "off" && modelSupportsVision(currentModel());
}

// The endpoint (cloud OpenRouter or local/LAN Ollama) new runs use, from Settings. For Ollama we
// override the template's baseURL with the user's saved server URL (Settings → Model) so runs can
// target Ollama on another machine; falls back to the localhost default if none/invalid is saved.
function currentEndpoint() {
  const key = store.getSetting("endpoint", "openrouter");
  const ep = ENDPOINTS.find((e) => e.key === key) ?? ENDPOINTS[0];
  if (ep.key === "ollama") {
    const baseURL = normalizeOllamaBaseUrl(store.getSetting("ollamaBaseUrl", "")) ?? DEFAULT_OLLAMA_BASE_URL;
    return { ...ep, baseURL };
  }
  return ep;
}
// A client pointed at the active endpoint (the OpenRouter singleton is left for embeddings/dreaming).
function currentClient() {
  const ep = currentEndpoint();
  const apiKey = ep.apiKey ?? (ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : "") ?? "";
  return makeClient(ep.baseURL, apiKey, ep.requestTimeoutMs);
}

// Before starting an Ollama run, confirm the configured server is actually reachable. Without this a
// saved-but-unreachable LAN host (e.g. a Mac Studio that's asleep) would leave the run sitting
// "working" for the full request timeout before failing — a fast bounded /api/tags probe turns that
// into an immediate, specific error the run route can show. Always ok for non-Ollama endpoints.
export async function preflightEndpoint(): Promise<{ ok: true } | { ok: false; problem: string }> {
  const ep = currentEndpoint();
  if (ep.key !== "ollama") {
    // Cloud endpoints need a key. Resolve it exactly as currentClient() does; a missing key becomes
    // a calm, actionable message at run start instead of an opaque 401 mid-run. (config no longer
    // throws at import when the key is absent — see config.ts — so this is the place that catches it.)
    const key = ep.apiKey ?? (ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : "") ?? "";
    if (!key) {
      return {
        ok: false,
        problem:
          "Add your OpenRouter API key to use the cloud model — set OPENROUTER_API_KEY, or switch to a local Ollama model in Settings → Model.",
      };
    }
    return { ok: true };
  }
  const tagsUrl = ep.baseURL.replace(/\/v1\/?$/, "") + "/api/tags";
  try {
    const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      return { ok: false, problem: `Your Ollama server at ${ep.baseURL} returned an error (${res.status}). Is Ollama running there?` };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      problem: `I couldn't reach your Ollama server at ${ep.baseURL}. Make sure it's running and on the same network, or switch back to OpenRouter in Settings.`,
    };
  }
}

// Prepend what Errand remembers about the user to the base prompt so it just knows them.
// `query` is the run's first message — used to retrieve only the memories relevant to THIS
// task (embedding-ranked), instead of dumping every memory into the prompt.
async function buildSystemPrompt(query: string): Promise<string> {
  // State today's date every run: a get_date tool exists, but the model only calls it if it
  // reasons to — for common asks ("files from last week", "what's due this month", "as of today")
  // a cheap/local model anchors on its training cutoff and answers wrongly without ever calling it.
  const dateLine = `Today is ${new Date().toDateString()}. Use this for anything time-related; only check the exact clock time with a tool when you truly need it.`;
  let base = `${dateLine}\n\n${SYSTEM_PROMPT}`;
  // Tell the model which saved skills exist (names + when-to-use) so it reaches for use_skill on a
  // matching task instead of improvising. Just a listing — the body is loaded on demand by use_skill.
  const skills = skillsSummary();
  if (skills) base += `\n\nSaved skills you can apply (call use_skill with the name to load the steps):\n${skills}`;
  const mems = await store.relevantMemories(query);
  if (!mems) return base;
  return `${base}\n\nWhat you remember about this person (use it naturally; never recite it back):\n${mems}`;
}

// Persist events to the DB; update status/changeCount on terminal events. Per-token streaming
// deltas are NOT persisted (they'd bloat the table and slow replay) — the live SSE buffer
// streams them within the session, and message.completed reconstructs the final text on replay.
function attachPersistence(entry: RunEntry): void {
  entry.sink.subscribe((e) => {
    if (entry.deleted) return; // deleted mid-run — don't re-add its in-flight events to the DB
    // A transient DB hiccup (locked by a second process, disk full) must degrade to "we didn't
    // save that event", not crash the run. WebSink.emit swallows subscriber throws, but persist
    // explicitly so a write failure can never interrupt the live stream or mark a run wrong.
    try {
      if (e.type !== "message.delta") store.appendEvent(entry.runId, e);
      // Persist the journal manifest the moment a mutating op completes, NOT only at turn-settle.
      // The destructive change + its snapshot already hit disk during tool.run; if the worker is
      // killed mid-turn, the end-of-turn persistJournal never runs and Undo-after-restart would
      // find no manifest. Persisting on each tool.result closes that crash window (idempotent via
      // INSERT OR IGNORE). The runTurn.finally call stays as a harmless backstop.
      if (e.type === "tool.result") persistJournal(entry);
      if (e.type === "run.finished") {
        store.setStatus(entry.runId, "done");
        store.setChangeCount(entry.runId, e.changes.length);
      } else if (e.type === "run.error") {
        store.setStatus(entry.runId, "stopped");
      }
    } catch (err) {
      console.warn(`[errand] failed to persist ${e.type} for run ${entry.runId} (continuing):`, err);
    }
  });
}

// Persist this run's journal manifest (idempotent via INSERT OR IGNORE). The live in-memory
// inverses still drive Undo while the run is in memory; this lets rebuildJournalFromStore
// reconstruct them after a restart or eviction.
function persistJournal(entry: RunEntry): void {
  for (const e of entry.session.journal.list()) {
    store.appendJournalOp(entry.runId, {
      opId: e.id,
      op: e.op,
      description: e.description,
      reversibility: e.reversibility,
      manifest: e.manifest,
    });
  }
}

// Enqueue a turn. The work chains onto entry.turnQueue so it can't begin until any prior turn has
// fully settled — guaranteeing one runner.send() at a time on this run's Session. The queue never
// rejects (execTurn swallows its own errors), so the chain can't break.
function runTurn(entry: RunEntry, message: string): void {
  const turnId = ++entry.turnSeq;
  entry.turnQueue = entry.turnQueue.then(() => execTurn(entry, message, turnId));
}

function execTurn(entry: RunEntry, message: string, turnId: number): Promise<void> {
  // Skip a turn that was removed OR cancelled while it sat queued (a Stop / delete during the queue
  // window takes effect, instead of the turn running once the one ahead of it settles).
  if (entry.deleted || turnId <= entry.cancelledThrough) return Promise.resolve();
  entry.abort = new AbortController(); // fresh per turn (AbortController is one-shot)
  entry.busy = true;
  return entry.runner
    .send(message, entry.abort.signal)
    .catch(() => {})
    .finally(() => {
      entry.busy = false;
      // Guard the post-turn writes: a throw in this .finally would become an unhandled
      // rejection that can take down the Next worker mid-errand. Saving the conversation or
      // kicking off dreaming failing should be silent, not fatal.
      try {
        store.setMessages(entry.runId, entry.session.messages); // durable conversation
        if (!entry.deleted) persistJournal(entry); // so Undo survives a restart / eviction
        maybeDream(); // reflect after the task settles (if dreaming is on)
      } catch (err) {
        console.warn(`[errand] post-turn persistence failed for run ${entry.runId} (continuing):`, err);
      }
    })
    .then(() => {}); // discard send()'s resolved value so the queue stays Promise<void>
}

export async function startRun(message: string, roots?: string[]): Promise<string> {
  const runId = crypto.randomUUID();
  const session = new Session(await buildSystemPrompt(message));
  const sink = new WebSink();
  const usedRoots = roots && roots.length ? roots : [config.workspaceRoot];
  const entry: RunEntry = {
    runId,
    session,
    sink,
    abort: new AbortController(),
    pending: new Map(),
    busy: false,
    autoApproveReversible: false,
    title: message.slice(0, 80),
    createdAt: Date.now(),
    turnQueue: Promise.resolve(),
    turnSeq: 0,
    cancelledThrough: 0,
    runner: undefined as unknown as AgentRunner,
  };
  entry.runner = new AgentRunner({
    session,
    sink,
    registry: buildRegistry(),
    model: currentModel(),
    client: currentClient(),
    stream: currentEndpoint().stream,
    vision: currentVision(),
    logger: new Logger(runId),
    runId,
    gate: new WebGate(entry),
    roots: usedRoots,
  });
  store.createRun(runId, entry.title, entry.createdAt, usedRoots);
  attachPersistence(entry);
  runs.set(runId, entry);
  runTurn(entry, message);
  return runId;
}

// Rehydrate a run that's no longer in memory (e.g. after a server restart) from the DB:
// restore the conversation, preload its event stream for replay, resume seq numbering.
function rehydrate(runId: string): RunEntry | undefined {
  const stored = store.getStoredRun(runId);
  if (!stored) return undefined;
  const events = store.getEvents(runId);
  const session = new Session(SYSTEM_PROMPT);
  if (stored.messages.length) session.loadMessages(stored.messages as any);
  // Restore the journal from its persisted manifest so Undo still works on this run (its live
  // inverse closures died with the previous process). No-op for runs that changed nothing.
  rebuildJournalFromStore(runId, session.journal);
  const sink = new WebSink();
  sink.preload(events);
  const maxSeq = events.length ? events[events.length - 1].seq : -1;
  const entry: RunEntry = {
    runId,
    session,
    sink,
    abort: new AbortController(),
    pending: new Map(),
    busy: false,
    autoApproveReversible: false,
    title: stored.title,
    createdAt: stored.createdAt,
    turnQueue: Promise.resolve(),
    turnSeq: 0,
    cancelledThrough: 0,
    runner: undefined as unknown as AgentRunner,
  };
  entry.runner = new AgentRunner({
    session,
    sink,
    registry: buildRegistry(),
    model: currentModel(),
    client: currentClient(),
    stream: currentEndpoint().stream,
    vision: currentVision(),
    logger: new Logger(runId),
    runId,
    gate: new WebGate(entry),
    roots: stored.roots.length ? stored.roots : [config.workspaceRoot],
    startSeq: maxSeq + 1,
  });
  attachPersistence(entry);
  runs.set(runId, entry);
  return entry;
}

export function getRun(runId: string): RunEntry | undefined {
  return runs.get(runId) ?? rehydrate(runId);
}

// Recently list from the DB (survives restart), newest first. Override status to
// "working" for any run that is currently busy in memory.
export function listRuns(): RunSummary[] {
  return store.listRunSummaries().map((r) => {
    const live = runs.get(r.runId);
    return live?.busy ? { ...r, status: "working" } : r;
  });
}

export function decide(runId: string, callId: string, decision: Decision): boolean {
  const entry = runs.get(runId);
  const resolve = entry?.pending.get(callId);
  if (!resolve) return false;
  resolve(decision);
  return true;
}

// "Yes to all (this errand)": approve the current request AND auto-approve future
// REVERSIBLE ones for the rest of this run. Permanent/unknown still always pause.
export function approveAlways(runId: string, callId: string): boolean {
  const entry = runs.get(runId);
  if (!entry) return false;
  entry.autoApproveReversible = true;
  const resolve = entry.pending.get(callId);
  if (resolve) resolve("approved");
  return true;
}

export function setAutoApprove(runId: string, enabled: boolean): boolean {
  const entry = runs.get(runId);
  if (!entry) return false;
  entry.autoApproveReversible = enabled;
  return true;
}

export function cancelRun(runId: string): boolean {
  const entry = runs.get(runId);
  if (!entry) return false;
  // Stop the running turn (abort) AND any turns already queued behind it (cancelledThrough), so a
  // Stop is never lost to a follow-up that hasn't started yet. A later sendMessage enqueues a fresh
  // turnId above cancelledThrough, so the user can still steer the run after stopping it.
  entry.cancelledThrough = entry.turnSeq;
  entry.abort.abort();
  return true;
}

// Permanently delete a run: stop it if live, drop it from memory, and remove it from the DB.
export function removeRun(runId: string): void {
  const entry = runs.get(runId);
  if (entry) {
    entry.deleted = true; // BEFORE abort, so its unwind events aren't re-persisted
    entry.abort.abort(); // stop it if it's mid-task
    runs.delete(runId);
  }
  store.deleteRun(runId);
}

// Send a message. If the agent is busy, INTERRUPT the current turn (the user is steering) by
// aborting it; the new turn is enqueued behind it and the turnQueue guarantees it won't START
// until the interrupted turn has fully settled — no fixed wait, no chance of two overlapping
// turns even if a tool ignores the abort signal.
export async function sendMessage(runId: string, message: string): Promise<"ok" | "missing"> {
  // getRun (not runs.get) so an interrupted run that fell out of memory after a restart can
  // still be continued — it rehydrates from the DB (restored Session + replayed events).
  const entry = getRun(runId);
  if (!entry) return "missing";
  if (entry.busy) entry.abort.abort(); // interrupt now; the queue serializes the handoff
  runTurn(entry, message);
  return "ok";
}

// Undo every reversible op this run journaled (delete→restore, write→prior bytes, …).
// If the run is live, use its in-memory journal. Otherwise rebuild a THROWAWAY journal from the
// persisted manifest and undo from that — never go through getRun/rehydrate, which would
// construct a full AgentRunner + a permanent sink subscription and leave the evicted run resident
// in the registry for the rest of the process (resource growth on every undo of an old run).
export async function undoRun(
  runId: string,
): Promise<{ undone: number; failed: number; skipped: number } | null> {
  const live = runs.get(runId);
  if (live) return live.session.journal.undoAll();
  if (!store.getStoredRun(runId)) return null;
  const journal = new Journal();
  rebuildJournalFromStore(runId, journal);
  return journal.undoAll();
}
