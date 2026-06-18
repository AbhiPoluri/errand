// Gated shell tool (the "power path" from decision #4). It is gated:true, so the loop
// PAUSES for human approval before it runs. It is sandboxed to the workspace root,
// denylisted against catastrophic commands (defense even after approval), time-limited,
// output-capped, and killed on cancellation. General shell can't be cleanly inverted, so
// it records a NON-reversible journal entry and describe() is honest about that.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";

const Args = z.object({ command: z.string().min(1) });
type Args = z.infer<typeof Args>;

const TIMEOUT_MS = 15_000;
const OUTPUT_CAP = 16_000;

// Catastrophic patterns refused even if the user approves.
const DENY = [
  /\brm\s+-rf?\s+[~/]/, // rm -rf / or ~
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=/,
  /:\(\)\s*\{/, // fork bomb
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  />\s*\/dev\/(sd|disk|null)?/, // writing to devices
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, // pipe-to-shell
  /\bchmod\s+-R\s+777\s+\//,
];

// Shell metacharacters mean describe() can't enumerate what will change.
const SHELL_META = /[|&;<>$`(){}\[\]*?]|\$\(/;

function programOf(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "command";
}

export const bash: Tool<Args> = {
  name: "run_command",
  modelDescription:
    "Run a shell command in the user's workspace folder. Use ONLY when a structured action isn't available. Requires the user's explicit approval and cannot be undone automatically.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: { command: { type: "string", description: "The shell command to run." } },
  },
  argsSchema: Args,
  gated: true,
  describe: (a) => {
    const unpredictable = SHELL_META.test(a.command);
    return {
      action: unpredictable
        ? "Run a command I can't fully predict"
        : `Run "${programOf(a.command)}"`,
      detail: a.command,
      consequences: unpredictable
        ? "I can't predict exactly what this will change, and it can't be undone automatically."
        : "This runs on your computer and can't be undone automatically.",
      reversibility: "unknown",
    };
  },
  summarize: (r) => {
    if (r.ok) return "Ran the command.";
    if (r.error === "blocked") return "I won't run that — it looks unsafe.";
    if (r.error === "killed") return "Stopped the command.";
    return "The command didn't finish cleanly.";
  },
  run: async (a, ctx) =>
    new Promise<ToolResult>((resolve) => {
      if (DENY.some((re) => re.test(a.command))) {
        return resolve({ ok: false, error: "blocked" });
      }
      mkdirSync(ctx.workspaceRoot, { recursive: true });

      const child = spawn(a.command, [], {
        shell: true,
        cwd: ctx.workspaceRoot,
        // Minimal env on purpose (defense-in-depth), cast to satisfy ProcessEnv.
        env: { PATH: process.env.PATH, HOME: process.env.HOME } as unknown as NodeJS.ProcessEnv,
      });

      let out = "",
        err = "",
        killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, TIMEOUT_MS);
      const onAbort = () => {
        killed = true;
        child.kill("SIGKILL");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      // Cap on APPEND, not just at the end: `out += d.toString()` would retain the FULL accumulated
      // output in RAM (a chatty command — a build log, cat of a big file — could spike to tens of MB
      // and risk an OOM mid-turn), even though only OUTPUT_CAP is ever returned. Slice each chunk to
      // the remaining budget so the accumulator never exceeds OUTPUT_CAP.
      child.stdout.on("data", (d) => {
        if (out.length < OUTPUT_CAP) out += d.toString().slice(0, OUTPUT_CAP - out.length);
      });
      child.stderr.on("data", (d) => {
        if (err.length < OUTPUT_CAP) err += d.toString().slice(0, OUTPUT_CAP - err.length);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ ok: false, error: String(e.message) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.journal.record({ op: "run_command", description: "Ran a command", reversibility: "unknown" });
        if (killed) return resolve({ ok: false, error: "killed", data: { stdout: out, stderr: err } });
        resolve({
          ok: code === 0,
          data: { code, stdout: out, stderr: err }, // already capped on append
          bytes: out.length + err.length, // accurate now: each accumulator is <= OUTPUT_CAP
          error: code === 0 ? undefined : `exit_${code}`,
        });
      });
    }),
};
