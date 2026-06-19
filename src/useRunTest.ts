// Locks resolveApprovalFailure (app/lib/useRun.ts): when a decision POST comes back not-ok, the wedged
// approval card must be cleared and a calm snag surfaced on the in-flight turn — and it must NOT clobber
// a different/fresh approval or act when the card is already gone. Pure reducer logic, no React/DOM.
// Run: `npm run userun:test`.
import { resolveApprovalFailure, type RunState } from "../app/lib/useRun.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const base: RunState = {
  runId: "r1",
  phase: "waiting",
  title: "t",
  statusLine: "Delete files",
  thinking: false,
  turns: [{ user: "delete the old files", steps: [], reply: "", problem: null }],
  approval: { callId: "c1", action: "Delete files", consequences: "", items: [], reversibility: "reversible" },
  problem: null,
  changes: [],
  undo: "idle",
  undoResult: null,
  autoApprove: false,
  screenshot: null,
};

// Matching callId: clears the card, sets a turn snag, leaves a non-waiting/non-thinking phase.
const r = resolveApprovalFailure(base, "c1");
check("clears the wedged approval card", r.approval === null);
check("phase leaves 'waiting' (no stuck progress bar)", r.phase === "error", r.phase);
check("not thinking", r.thinking === false);
check("surfaces a calm snag on the in-flight turn", !!r.turns[r.turns.length - 1].problem, r.turns[0].problem ?? "");
check("does not mutate the input state", base.approval !== null && base.phase === "waiting");

// Custom message is honored.
const r2 = resolveApprovalFailure(base, "c1", "expired!");
check("custom message used", r2.turns[0].problem === "expired!", r2.turns[0].problem ?? "");

// Different callId now showing → no-op (don't clobber a fresh approval).
const fresh = { ...base, approval: { ...base.approval!, callId: "c2" } };
check("no-op when a DIFFERENT approval is showing", resolveApprovalFailure(fresh, "c1") === fresh);

// Card already gone → no-op.
const cleared = { ...base, approval: null };
check("no-op when the card is already cleared", resolveApprovalFailure(cleared, "c1") === cleared);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
