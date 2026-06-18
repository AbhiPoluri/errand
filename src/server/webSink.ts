// Web event sink: buffers every AgentEvent (a ring of the run's history) and fans out
// to live SSE subscribers. A late or reconnecting subscriber replays from a seq.
import type { AgentEvent, EventSink } from "../events.ts";

export class WebSink implements EventSink {
  private buffer: AgentEvent[] = [];
  private subs = new Set<(e: AgentEvent) => void>();
  done = false;

  emit(e: AgentEvent): void {
    this.buffer.push(e);
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        // a broken subscriber must never break the run
      }
    }
  }

  // Replay everything with seq >= fromSeq, then receive live events. Returns unsubscribe.
  subscribe(fn: (e: AgentEvent) => void, fromSeq = 0): () => void {
    for (const e of this.buffer) if (e.seq >= fromSeq) fn(e);
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  lastSeq(): number {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].seq : -1;
  }

  events(): readonly AgentEvent[] {
    return this.buffer;
  }

  // Seed the buffer from persisted events (rehydration) without notifying/re-persisting.
  preload(events: AgentEvent[]): void {
    this.buffer = events.slice();
  }
}
