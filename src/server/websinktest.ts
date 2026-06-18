// WebSink test (rank 11) — offline, no deps. Verifies that a long streamed reply doesn't grow
// the structural buffer in proportion to token count, deltas are bounded, and a late subscriber
// still receives every structural event in seq order (the transcript stays intact).
import { WebSink } from "./webSink.ts";
import type { AgentEvent } from "../events.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const ev = (seq: number, body: any): AgentEvent => ({ runId: "r", turnId: "t", seq, ts: 1, ...body }) as AgentEvent;

async function main() {
  const sink = new WebSink();
  sink.emit(ev(0, { type: "run.started", title: "hi" }));
  sink.emit(ev(1, { type: "user.message", text: "go" }));
  // 1000 streamed tokens.
  for (let i = 0; i < 1000; i++) sink.emit(ev(2 + i, { type: "message.delta", text: "x" }));
  sink.emit(ev(1002, { type: "message.completed", text: "the full reply" }));
  sink.emit(ev(1003, { type: "run.finished", status: "completed", finalMessage: "the full reply", changes: [] }));

  console.log("\n== bounded buffers ==");
  // Structural buffer holds only the 4 structural events, NOT the 1000 deltas.
  check("structural buffer is bounded (4 events, not 1004)", sink.events().length === 4, `${sink.events().length}`);
  check("lastSeq tracks the true max across deltas + structural", sink.lastSeq() === 1003, `${sink.lastSeq()}`);

  console.log("\n== late subscriber gets a coherent transcript ==");
  const got: AgentEvent[] = [];
  const unsub = sink.subscribe((e) => got.push(e), 0);
  unsub();
  const structural = got.filter((e) => e.type !== "message.delta");
  const deltas = got.filter((e) => e.type === "message.delta");
  check("received all 4 structural events", structural.length === 4, `${structural.length}`);
  check("delta window is bounded (<= 400)", deltas.length <= 400, `${deltas.length}`);
  check("replay is in seq order", got.every((e, i) => i === 0 || e.seq >= got[i - 1].seq));
  check("message.completed (full text) is present for transcript resolution", got.some((e) => e.type === "message.completed"));
  check("the most recent delta is retained (live catch-up)", deltas[deltas.length - 1]?.seq === 1001);

  console.log("\n== preload seeds structural only ==");
  const sink2 = new WebSink();
  sink2.preload([ev(0, { type: "run.started", title: "x" }), ev(1, { type: "message.completed", text: "done" })]);
  check("preload sets buffer + maxSeq", sink2.events().length === 2 && sink2.lastSeq() === 1);

  console.log("\n== onDone fires once on a terminal event ==");
  const s3 = new WebSink();
  let doneCount = 0;
  s3.onDone(() => doneCount++);
  s3.emit(ev(0, { type: "run.started", title: "x" }));
  check("onDone not fired before a terminal event", doneCount === 0);
  s3.emit(ev(1, { type: "run.finished", status: "completed", finalMessage: "", changes: [] }));
  check("onDone fired on run.finished", doneCount === 1);
  s3.emit(ev(2, { type: "run.error", kind: "transport", userMessage: "x", recoverable: true }));
  check("onDone NOT fired again (cleared after first)", doneCount === 1);
  let lateFired = false;
  s3.onDone(() => (lateFired = true)); // registering on an already-done sink
  await new Promise((r) => setTimeout(r, 0));
  check("onDone on an already-done sink still fires (microtask)", lateFired);

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
