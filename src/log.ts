// JSONL trace — the ONLY home for raw args/results/errors/usage/finish_reason.
// User-facing surfaces never read this; it's for debugging + the v6 resumable transcript.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logsRoot } from "./paths.ts";

export class Logger {
  private file: string;

  // Default dir from paths.logsRoot() (ERRAND_LOGS > ERRAND_DATA-derived > cwd/logs), resolved per
  // construction so a host that sets the env is honored. Callers may still pass an explicit dir.
  constructor(runId: string, dir = logsRoot()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `run-${runId}.jsonl`);
  }

  // record anything: emitted events, usage, raw tool args/results, raw errors.
  log(kind: string, data: unknown): void {
    try {
      let line: string;
      try {
        line = JSON.stringify({ ts: Date.now(), kind, data }) + "\n";
      } catch {
        // `data` is `unknown` (raw SDK objects / errors / usage). A circular reference or a BigInt
        // makes JSON.stringify throw — record the kind and drop the payload rather than letting the
        // throw escape into the run. The trace is best-effort; a crash here would break the contract.
        line = JSON.stringify({ ts: Date.now(), kind, data: "[unserializable]" }) + "\n";
      }
      appendFileSync(this.file, line);
    } catch {
      // never let logging break a run
    }
  }
}
