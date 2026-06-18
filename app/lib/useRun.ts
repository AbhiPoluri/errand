"use client";
// Client hook: starts a run, watches its SSE stream, and reduces the AgentEvent stream
// into the UI state the Run View renders. The browser only ever sees plain-language
// events — never raw tool output, logs, or tokens.
import { useCallback, useRef, useState } from "react";
import type { AgentEvent } from "../../src/events.ts";

export type StepState = "running" | "done" | "failed" | "waiting";
export type Reversibility = "reversible" | "permanent" | "unknown";
export interface Step {
  callId: string;
  action: string;
  state: StepState;
  summary?: string;
  reversibility?: Reversibility;
}
export interface Approval {
  callId: string;
  action: string;
  consequences: string;
  items: string[];
  overflowCount?: number;
  reversibility: Reversibility;
}
export type Phase = "idle" | "running" | "waiting" | "done" | "error";
export type UndoState = "idle" | "undoing" | "done";
// One exchange: the user's message + the agent's steps + its reply for that turn.
export interface Turn {
  user: string;
  steps: Step[];
  reply: string;
  problem: string | null;
}
export interface RunState {
  runId: string | null;
  phase: Phase;
  title: string;
  statusLine: string;
  thinking: boolean;
  turns: Turn[]; // the full conversation transcript
  approval: Approval | null;
  problem: string | null; // run-level (e.g. failed to start, before any turn)
  changes: { summary: string; reversibility: Reversibility; undoable: boolean }[];
  undo: UndoState;
  undoResult: { undone: number; failed: number; skipped: number } | null;
  autoApprove: boolean; // "Yes to all (this errand)" is on — reversible actions only
  screenshot: string | null; // latest live browser view (JPEG data URL)
}

const EMPTY: RunState = {
  runId: null,
  phase: "idle",
  title: "",
  statusLine: "",
  thinking: false,
  turns: [],
  approval: null,
  problem: null,
  changes: [],
  undo: "idle",
  undoResult: null,
  autoApprove: false,
  screenshot: null,
};

// Update the in-flight (last) turn.
function updateLast(s: RunState, fn: (t: Turn) => Turn): RunState {
  if (!s.turns.length) return s;
  const turns = s.turns.slice();
  turns[turns.length - 1] = fn(turns[turns.length - 1]);
  return { ...s, turns };
}

function apply(s: RunState, e: AgentEvent): RunState {
  switch (e.type) {
    case "run.started":
      return { ...s, phase: "running", title: e.title, thinking: true, statusLine: "Getting started…" };
    case "user.message":
      return {
        ...s,
        phase: "running",
        thinking: true,
        statusLine: "Getting started…",
        approval: null,
        problem: null,
        turns: [...s.turns, { user: e.text, steps: [], reply: "", problem: null }],
      };
    case "turn.started":
      return { ...s, phase: "running", thinking: true };
    case "thinking.summary":
      return { ...s, thinking: true, statusLine: s.statusLine || "Thinking it through…" };
    case "message.delta":
      // Streamed token — append to the in-flight reply (the alive feel). The final
      // message.completed sets the full text, so replay (which drops deltas) still resolves.
      return { ...updateLast(s, (t) => ({ ...t, reply: t.reply + e.text })), thinking: false };
    case "message.completed":
      return { ...updateLast(s, (t) => ({ ...t, reply: e.text })), thinking: false };
    case "message.refusal":
      return { ...updateLast(s, (t) => ({ ...t, reply: e.text })), thinking: false };
    case "tool.proposed": {
      const step: Step = { callId: e.callId, action: e.action, state: "running", reversibility: e.reversibility };
      return { ...updateLast(s, (t) => ({ ...t, steps: upsert(t.steps, step) })), thinking: false, statusLine: e.action };
    }
    case "approval.required":
      return {
        ...updateLast(s, (t) => ({
          ...t,
          steps: upsert(t.steps, { callId: e.callId, action: e.action, state: "waiting", reversibility: e.reversibility }),
        })),
        phase: "waiting",
        thinking: false,
        statusLine: e.action,
        approval: {
          callId: e.callId,
          action: e.action,
          consequences: e.consequences,
          items: e.items,
          overflowCount: e.overflowCount,
          reversibility: e.reversibility,
        },
      };
    case "approval.resolved":
      return { ...s, phase: "running", approval: null };
    case "tool.started":
      return { ...updateLast(s, (t) => ({ ...t, steps: patch(t.steps, e.callId, { state: "running" }) })), statusLine: e.action };
    case "screenshot":
      return { ...s, screenshot: e.dataUrl };
    case "tool.result":
      return updateLast(s, (t) => ({
        ...t,
        steps: patch(t.steps, e.callId, { state: e.ok ? "done" : "failed", summary: e.summary }),
      }));
    case "run.error":
      if (e.kind === "cancelled") return { ...s, phase: "done", thinking: false, statusLine: e.userMessage };
      if (s.turns.length) return { ...updateLast(s, (t) => ({ ...t, problem: e.userMessage })), phase: "error", thinking: false };
      return { ...s, phase: "error", thinking: false, problem: e.userMessage };
    case "run.finished":
      return {
        ...updateLast(s, (t) => ({ ...t, reply: e.finalMessage || t.reply })),
        phase: "done",
        thinking: false,
        changes: e.changes ?? [],
      };
    default:
      return s; // streaming deltas (v5+) ignored for now
  }
}

function upsert(steps: Step[], step: Step): Step[] {
  const i = steps.findIndex((x) => x.callId === step.callId);
  if (i === -1) return [...steps, step];
  const next = steps.slice();
  next[i] = { ...next[i], ...step };
  return next;
}
function patch(steps: Step[], callId: string, p: Partial<Step>): Step[] {
  return steps.map((x) => (x.callId === callId ? { ...x, ...p } : x));
}

export function useRun() {
  const [state, setState] = useState<RunState>(EMPTY);
  const esRef = useRef<EventSource | null>(null);

  const openStream = useCallback((runId: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.onmessage = (m) => {
      try {
        const event = JSON.parse(m.data) as AgentEvent;
        setState((s) => apply(s, event));
      } catch {
        // ignore malformed frames / heartbeats
      }
    };
    esRef.current = es;
  }, []);

  const start = useCallback(
    async (message: string, roots?: string[]) => {
      setState({ ...EMPTY, phase: "running", title: message, statusLine: "Getting started…", thinking: true });
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, roots }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.runId) {
        setState((s) => ({ ...s, phase: "error", problem: data?.error || "I couldn't get started just now. Try again?" }));
        return;
      }
      setState((s) => ({ ...s, runId: data.runId }));
      openStream(data.runId);
    },
    [openStream],
  );

  const decide = useCallback(
    async (decision: "approved" | "denied" | "approved_always") => {
      const { runId, approval } = stateRef.current;
      if (!runId || !approval) return;
      if (decision === "approved_always") setState((s) => ({ ...s, autoApprove: true }));
      await fetch(`/api/runs/${runId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: approval.callId, decision }),
      });
    },
    [],
  );

  // Reopen a past run: its buffered event stream replays and the reducer rebuilds the
  // final Run View state (timeline, changes, final reply).
  const open = useCallback(
    (runId: string) => {
      setState({ ...EMPTY, runId, phase: "running", statusLine: "Loading…" });
      openStream(runId);
    },
    [openStream],
  );

  const cancelAuto = useCallback(async () => {
    const { runId } = stateRef.current;
    if (!runId) return;
    setState((s) => ({ ...s, autoApprove: false }));
    await fetch(`/api/runs/${runId}/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
  }, []);

  const cancel = useCallback(async () => {
    const { runId } = stateRef.current;
    if (!runId) return;
    await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
  }, []);

  const followUp = useCallback(async (message: string) => {
    const { runId } = stateRef.current;
    if (!runId) return;
    setState((s) => ({ ...s, phase: "running", thinking: true, problem: null, statusLine: "Getting started…" }));
    await fetch(`/api/runs/${runId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
  }, []);

  const undo = useCallback(async () => {
    const { runId } = stateRef.current;
    if (!runId) return;
    setState((s) => ({ ...s, undo: "undoing" }));
    // Capture the REAL outcome — never claim total success on a partial/failed undo.
    let result: RunState["undoResult"] = null;
    try {
      const res = await fetch(`/api/runs/${runId}/undo`, { method: "POST" });
      const data = await res.json();
      if (typeof data?.undone === "number") {
        result = { undone: data.undone, failed: data.failed ?? 0, skipped: data.skipped ?? 0 };
      }
    } catch {
      /* leave result null → honest fallback copy */
    }
    setState((s) => ({ ...s, undo: "done", undoResult: result }));
  }, []);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setState(EMPTY);
  }, []);

  // keep a ref of the latest state for the callbacks above
  const stateRef = useRef(state);
  stateRef.current = state;

  return {
    state,
    start,
    open,
    approve: () => decide("approved"),
    approveAlways: () => decide("approved_always"),
    cancelAuto,
    deny: () => decide("denied"),
    cancel,
    followUp,
    undo,
    reset,
  };
}
