// Web event sink: buffers a run's history and fans out to live SSE subscribers. A late or
// reconnecting subscriber replays from a seq.
//
// message.delta is the only per-token event, so it would grow the buffer in proportion to the
// reply length (an always-open SSE connection that lives across turns replays the whole buffer
// on every reconnect). We therefore keep STRUCTURAL events (tool calls, approvals, errors,
// message.completed, …) in the durable buffer and route message.delta into a small capped ring.
// Dropping old deltas is lossless for the transcript: message.completed (structural) carries the
// full reply text, so any fuller replay still resolves correctly.
import type { AgentEvent, EventSink } from "../events.ts";

export class WebSink implements EventSink {
  private buffer: AgentEvent[] = []; // structural events — the durable transcript
  private recentDeltas: AgentEvent[] = []; // message.delta ring — live catch-up only
  private subs = new Set<(e: AgentEvent) => void>();
  private onDoneCbs = new Set<() => void>();
  done = false;
  private maxSeq = -1;

  // Enough deltas for a live reader to catch up mid-reply; older ones are dropped (the final
  // message.completed reconstructs the text). A long streamed reply is bounded to this, not O(tokens).
  private static readonly MAX_DELTAS = 400;

  emit(e: AgentEvent): void {
    if (e.seq > this.maxSeq) this.maxSeq = e.seq;
    if (e.type === "message.delta") {
      this.recentDeltas.push(e);
      if (this.recentDeltas.length > WebSink.MAX_DELTAS) this.recentDeltas.shift();
    } else {
      this.buffer.push(e);
    }
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        // a broken subscriber must never break the run
      }
    }
    // After delivering a TERMINAL event, notify done-listeners so the SSE route can close cleanly
    // (and stop pinning this run's buffer + interval) instead of lingering until a socket close.
    if (e.type === "run.finished" || e.type === "run.error") {
      this.done = true;
      const cbs = [...this.onDoneCbs];
      this.onDoneCbs.clear();
      for (const fn of cbs) {
        try {
          fn();
        } catch {
          /* a broken done-listener must never break the run */
        }
      }
    }
  }

  // Fire `fn` once when the run reaches a terminal state (or now, on a microtask, if it already
  // has — so a reopened finished run still gets a clean teardown after replay). Returns unsubscribe.
  onDone(fn: () => void): () => void {
    if (this.done) {
      queueMicrotask(() => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      });
      return () => {};
    }
    this.onDoneCbs.add(fn);
    return () => this.onDoneCbs.delete(fn);
  }

  // Replay everything with seq >= fromSeq (structural + the recent delta window), in seq order,
  // then receive live events. Returns unsubscribe.
  subscribe(fn: (e: AgentEvent) => void, fromSeq = 0): () => void {
    const replay = [...this.buffer, ...this.recentDeltas]
      .filter((e) => e.seq >= fromSeq)
      .sort((a, b) => a.seq - b.seq);
    for (const e of replay) fn(e);
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  lastSeq(): number {
    return this.maxSeq;
  }

  events(): readonly AgentEvent[] {
    return this.buffer;
  }

  // Seed the buffer from persisted events (rehydration) without notifying/re-persisting.
  // Persisted events are structural only (deltas are never persisted).
  preload(events: AgentEvent[]): void {
    this.buffer = events.slice();
    this.recentDeltas = [];
    this.maxSeq = events.length ? events[events.length - 1].seq : -1;
  }
}
