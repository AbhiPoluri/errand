// Verifies the durable-seq fix: message.delta (the only never-persisted event) must NOT advance
// the durable seq counter, so the persisted (structural) seq space stays contiguous and a
// rehydrated run's startSeq = maxPersistedSeq+1 is always strictly greater than any seq a live
// client already consumed — including via a delta. Before the fix, deltas advanced seq, so a
// post-restart structural event could be minted at a seq a tab already saw (Last-Event-ID),
// silently skipping it on reconnect. Fully offline (streaming stub client). Run: `npm run seq:test`.
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Registry } from "./tools/index.ts";
import { AgentRunner } from "./loop.ts";
import type { AgentEvent, EventSink } from "./events.ts";
import type OpenAI from "openai";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

class Tap implements EventSink {
  events: AgentEvent[] = [];
  emit(e: AgentEvent) {
    this.events.push(e);
  }
}

// A streaming completion: yields content deltas, then ends cleanly (finish_reason on the last
// chunk). The loop accumulates the text and emits a structural message.completed at the end.
function streamStub(chunks: any[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          return i < chunks.length
            ? Promise.resolve({ done: false, value: chunks[i++] })
            : Promise.resolve({ done: true, value: undefined });
        },
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
    controller: { abort() {} },
  };
}
function streamClient(chunks: any[]): OpenAI {
  return { chat: { completions: { create: async () => streamStub(chunks) } } } as unknown as OpenAI;
}

// Several content tokens so multiple deltas surround the structural events.
const REPLY_CHUNKS = [
  { choices: [{ delta: { content: "He" } }] },
  { choices: [{ delta: { content: "llo " } }] },
  { choices: [{ delta: { content: "there" }, finish_reason: "stop" }] },
];

async function main(): Promise<void> {
  const runId = crypto.randomUUID();
  const session = new Session("system");
  const tap = new Tap();
  const runner = new AgentRunner({
    session,
    sink: tap,
    registry: new Registry(),
    model: "stub",
    logger: new Logger(runId),
    runId,
    client: streamClient(REPLY_CHUNKS),
    stream: true,
  });
  await runner.send("hi", new AbortController().signal);

  const structural = tap.events.filter((e) => e.type !== "message.delta");
  const deltas = tap.events.filter((e) => e.type === "message.delta");
  check("the stream produced delta events", deltas.length >= 2, `${deltas.length} deltas`);
  check("the stream produced structural events", structural.length >= 3, `${structural.length} structural`);

  // 1. Persisted (structural) seqs are contiguous from 0 — the property startSeq relies on.
  const structuralSeqs = structural.map((e) => e.seq);
  const contiguous = structuralSeqs.every((s, i) => s === i);
  check("structural seqs are contiguous from 0", contiguous, `[${structuralSeqs.join(",")}]`);

  const maxStructuralSeq = Math.max(...structuralSeqs);
  const maxDeltaSeq = Math.max(...deltas.map((e) => e.seq));

  // 2. THE FIX: no delta seq exceeds the persisted (structural) seq space. (Would FAIL before the
  //    fix, where deltas after the last structural event advanced seq past maxStructuralSeq.)
  check(
    "no delta seq exceeds the max persisted structural seq",
    deltas.every((e) => e.seq <= maxStructuralSeq),
    `maxDelta=${maxDeltaSeq} maxStructural=${maxStructuralSeq}`,
  );

  // 3. Each delta sorts after the preceding structural event and strictly before the next one,
  //    so a reconnect past the next event filters it out (no double-apply, no skip).
  let deltaOrderOk = true;
  for (const d of deltas) {
    const nextStructural = structural.find((s) => s.seq > d.seq);
    if (nextStructural && d.seq >= nextStructural.seq) deltaOrderOk = false;
  }
  check("every delta seq < the next structural seq", deltaOrderOk);

  // 4. Simulate restart → rehydrate: startSeq is computed from the PERSISTED (structural) events.
  //    A reconnecting tab's Last-Event-ID can be at most maxDeltaSeq (deltas carry an SSE id too).
  //    The new run must mint its next structural event ABOVE that, or the tab skips it.
  const startSeq = maxStructuralSeq + 1; // mirrors rehydrate(): maxPersistedSeq + 1
  check("rehydrate startSeq is above every seq the client could have seen", startSeq > maxDeltaSeq && startSeq > maxStructuralSeq);

  const session2 = new Session("system");
  session2.loadMessages(session.messages as any);
  const tap2 = new Tap();
  const runner2 = new AgentRunner({
    session: session2,
    sink: tap2,
    registry: new Registry(),
    model: "stub",
    logger: new Logger(runId),
    runId,
    client: streamClient(REPLY_CHUNKS),
    stream: true,
    startSeq,
  });
  await runner2.send("again", new AbortController().signal);
  const firstNew = tap2.events[0];
  check("a rehydrated run resumes seq exactly at startSeq", firstNew?.seq === startSeq, `first new seq=${firstNew?.seq}`);
  check(
    "the first post-restart structural event is delivered to a tab at Last-Event-ID=maxDeltaSeq",
    firstNew !== undefined && firstNew.seq >= maxDeltaSeq + 1,
    `newSeq=${firstNew?.seq} fromSeq=${maxDeltaSeq + 1}`,
  );

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
