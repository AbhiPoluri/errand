// The shared contract between the harness and ANY renderer (CLI sink, web/SSE sink).
// The loop emits ONLY these events — it never console.logs or returns strings to a UI.
// A discriminated union + an exhaustive switch forces every renderer to handle every
// event at compile time. Events emitted only from later milestones are marked.
import type { Reversibility } from "./tools/index.ts";

export interface EventMeta {
  runId: string;
  turnId: string;
  // Monotonic across STRUCTURAL (persisted) events; message.delta borrows the preceding structural
  // seq (see loop.ts emit), so a delta's seq is not unique. Used as the SSE id:; a client resumes
  // from Last-Event-ID and the buffer replays seq >= fromSeq (range filter, not equality dedupe) —
  // deltas are losslessly droppable since message.completed carries the full text.
  seq: number;
  ts: number; // epoch ms
}

// The body (everything except the per-event metadata). The loop emits a body; the
// runner stamps runId/turnId/seq/ts. (Kept separate because TS's Omit collapses
// discriminated unions, losing variant-specific fields.)
export type AgentEventBody =
  (
    | { type: "run.started"; title: string }
    | { type: "user.message"; text: string } // the user's message for this turn (drives the transcript)
    | { type: "turn.started"; index: number; maxIterations: number }
    // --- streaming: message.delta is emitted from v4 (non-streaming uses message.completed) ---
    | { type: "thinking.summary"; summary: string }
    | { type: "message.delta"; text: string }
    // --- v1 ---
    | { type: "message.completed"; text: string }
    | {
        type: "tool.proposed";
        callId: string;
        action: string;
        detail?: string;
        reversibility: Reversibility;
      }
    // --- approval gate: emitted from v2 (the loop suspends on a Promise here) ---
    | {
        type: "approval.required";
        callId: string;
        action: string;
        consequences: string;
        items: string[];
        overflowCount?: number;
        reversibility: Reversibility;
      }
    | { type: "tool.started"; callId: string; action: string }
    // live browser view — a JPEG data URL the Run View shows so the user watches the agent
    | { type: "screenshot"; dataUrl: string }
    | {
        type: "tool.result";
        callId: string;
        ok: boolean;
        summary: string;
        bytes?: number;
      }
    | {
        type: "approval.resolved";
        callId: string;
        decision: "approved" | "denied" | "cancelled" | "expired";
      }
    | {
        type: "run.error";
        kind:
          | "length"
          | "content_filter"
          | "max_iterations"
          | "cancelled"
          | "transport"
          | "internal";
        userMessage: string; // plain, reassuring, NO stack/jargon — stack lives in the trace
        recoverable: boolean;
      }
    | {
        type: "run.finished";
        status: "completed"; // cancellation flows through run.error (kind:"cancelled"), never here
        finalMessage: string;
        changes: { summary: string; reversibility: Reversibility; undoable: boolean; journaledOpId?: string }[];
      }
  );

export type AgentEvent = EventMeta & AgentEventBody;

// A sink renders/serializes events. The loop is handed one; it knows nothing else.
export interface EventSink {
  emit(event: AgentEvent): void | Promise<void>;
}
