// The approval gate. When a gated tool is about to run, the loop SUSPENDS on
// gate.request(...) until a decision arrives. The gate NEVER rejects — it always
// resolves to a Decision (a reject would throw mid-loop and strand a tool_call).
// In v4 the web implementation parks the promise in a RunRegistry and a /decision
// endpoint resolves it; here we provide CLI, scripted, and auto implementations.
import type readline from "node:readline";
import type { Reversibility } from "./tools/index.ts";

export type Decision = "approved" | "denied" | "cancelled" | "expired";

export interface ApprovalRequest {
  callId: string;
  action: string;
  consequences: string;
  items: string[];
  overflowCount?: number;
  reversibility: Reversibility;
}

export interface ApprovalGate {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<Decision>;
  // True if this request should be auto-approved without pausing. The loop ONLY consults
  // this for `reversibility === "reversible"` requests — permanent/unknown always ask.
  autoApproves?(req: ApprovalRequest): boolean;
}

// Terminal y/n prompt, integrated with the REPL's readline so stdin isn't double-read.
export class CliApprovalGate implements ApprovalGate {
  constructor(private rl: readline.Interface) {}

  request(req: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      if (signal.aborted) return resolve("cancelled");
      let done = false;
      const finish = (d: Decision) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve(d);
      };
      const onAbort = () => finish("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });

      const sample = req.items.slice(0, 5).join(", ");
      const more = req.overflowCount ? ` …and ${req.overflowCount} more` : "";
      if (sample) process.stdout.write(`\x1b[2m     items: ${sample}${more}\x1b[0m\n`);
      this.rl.question(`\x1b[33m   Allow this? (y/N) \x1b[0m`, (answer) => {
        const a = answer.trim().toLowerCase();
        finish(a === "y" || a === "yes" ? "approved" : "denied");
      });
    });
  }
}

// For tests/headless: resolve every request the same way (or run a scripted sequence).
export class ScriptedApprovalGate implements ApprovalGate {
  private i = 0;
  constructor(private script: Decision[] = [], private fallback: Decision = "denied") {}
  request(_req: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    if (signal.aborted) return Promise.resolve("cancelled");
    const d = this.i < this.script.length ? this.script[this.i++] : this.fallback;
    return Promise.resolve(d);
  }
}

export class AutoDenyGate implements ApprovalGate {
  request(): Promise<Decision> {
    return Promise.resolve("denied");
  }
}
