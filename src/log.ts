// JSONL trace — the ONLY home for raw args/results/errors/usage/finish_reason.
// User-facing surfaces never read this; it's for debugging + the v6 resumable transcript.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class Logger {
  private file: string;

  constructor(runId: string, dir = "logs") {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `run-${runId}.jsonl`);
  }

  // record anything: emitted events, usage, raw tool args/results, raw errors.
  log(kind: string, data: unknown): void {
    const line = JSON.stringify({ ts: Date.now(), kind, data }) + "\n";
    try {
      appendFileSync(this.file, line);
    } catch {
      // never let logging break a run
    }
  }
}
