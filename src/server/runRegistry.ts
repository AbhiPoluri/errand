// In-memory run registry (the v1 hosting seam — see PLAN.md open risks). Holds each
// live run so the SSE stream, /decision, /cancel, and /message endpoints can reach the
// parked loop. Stored on globalThis so Next.js dev HMR doesn't drop live runs.
import { config } from "../config.ts";
import { Session } from "../session.ts";
import { Logger } from "../log.ts";
import { Registry } from "../tools/index.ts";
import { buildRegistryFor, DEFAULT_PACKS } from "../capabilities/index.ts";
import { makeClient } from "../client.ts";
import { ENDPOINTS } from "../models.ts";
import { AgentRunner } from "../loop.ts";
import { type ApprovalGate, type ApprovalRequest, type Decision } from "../approvals.ts";
import { SYSTEM_PROMPT } from "../prompt.ts";
import { WebSink } from "./webSink.ts";
import * as store from "./store.ts";
import { dream } from "./dream.ts";

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

const g = globalThis as unknown as { __errandRuns?: Map<string, RunEntry>; __errandReconciled?: boolean };
const runs: Map<string, RunEntry> = (g.__errandRuns ??= new Map());

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
  // Consumer default: the no-auth capability packs (files/web/browser/memory). General `bash`
  // is the "power path" (decision #4) and is intentionally NOT in any web pack yet.
  return buildRegistryFor(DEFAULT_PACKS);
}

// The model new runs use: the user's saved choice (Settings → model switcher) or the env
// default. Read per-run so switching the model takes effect on the next run, no restart.
function currentModel(): string {
  return store.getSetting("model", config.model);
}

// The endpoint (cloud OpenRouter or local Ollama) new runs use, from Settings.
function currentEndpoint() {
  const key = store.getSetting("endpoint", "openrouter");
  return ENDPOINTS.find((e) => e.key === key) ?? ENDPOINTS[0];
}
// A client pointed at the active endpoint (the OpenRouter singleton is left for embeddings/dreaming).
function currentClient() {
  const ep = currentEndpoint();
  const apiKey = ep.apiKey ?? (ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : "") ?? "";
  return makeClient(ep.baseURL, apiKey);
}

// Prepend what Errand remembers about the user to the base prompt so it just knows them.
// `query` is the run's first message — used to retrieve only the memories relevant to THIS
// task (embedding-ranked), instead of dumping every memory into the prompt.
async function buildSystemPrompt(query: string): Promise<string> {
  const mems = await store.relevantMemories(query);
  if (!mems) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n\nWhat you remember about this person (use it naturally; never recite it back):\n${mems}`;
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
      if (e.type !== "message.delta" && e.type !== "thinking.delta") store.appendEvent(entry.runId, e);
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

function runTurn(entry: RunEntry, message: string): void {
  entry.abort = new AbortController(); // fresh per turn (AbortController is one-shot)
  entry.busy = true;
  entry.runner
    .send(message, entry.abort.signal)
    .catch(() => {})
    .finally(() => {
      entry.busy = false;
      // Guard the post-turn writes: a throw in this .finally would become an unhandled
      // rejection that can take down the Next worker mid-errand. Saving the conversation or
      // kicking off dreaming failing should be silent, not fatal.
      try {
        store.setMessages(entry.runId, entry.session.messages); // durable conversation
        maybeDream(); // reflect after the task settles (if dreaming is on)
      } catch (err) {
        console.warn(`[errand] post-turn persistence failed for run ${entry.runId} (continuing):`, err);
      }
    });
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
    runner: undefined as unknown as AgentRunner,
  };
  entry.runner = new AgentRunner({
    session,
    sink,
    registry: buildRegistry(),
    model: currentModel(),
    client: currentClient(),
    stream: currentEndpoint().stream,
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
    runner: undefined as unknown as AgentRunner,
  };
  entry.runner = new AgentRunner({
    session,
    sink,
    registry: buildRegistry(),
    model: currentModel(),
    client: currentClient(),
    stream: currentEndpoint().stream,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Send a message. If the agent is busy, INTERRUPT the current turn first (the user is
// steering), wait for it to settle, then run the new instruction.
export async function sendMessage(runId: string, message: string): Promise<"ok" | "missing"> {
  // getRun (not runs.get) so an interrupted run that fell out of memory after a restart can
  // still be continued — it rehydrates from the DB (restored Session + replayed events).
  const entry = getRun(runId);
  if (!entry) return "missing";
  if (entry.busy) {
    entry.abort.abort();
    for (let i = 0; i < 50 && entry.busy; i++) await sleep(100); // let the current turn unwind
  }
  runTurn(entry, message);
  return "ok";
}

// Undo every reversible op this run journaled (delete→restore, write→prior bytes, …).
export async function undoRun(
  runId: string,
): Promise<{ undone: number; failed: number; skipped: number } | null> {
  const entry = runs.get(runId);
  if (!entry) return null;
  return entry.session.journal.undoAll();
}
