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

// Catastrophic patterns refused even if the user approves. Exported so bashTest can lock them — a
// regex regression here would silently let a destructive command through after approval. These are
// tested against a NORMALIZED command (quotes stripped, whitespace collapsed) so quote- or
// newline-obfuscation can't slip past. The recursive-rm case is handled separately (isCatastrophicRm)
// because "-rf | -fr | -r -f | --recursive --force" against "/ | ~ | $HOME | .." doesn't fit one
// readable pattern.
export const DENY = [
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=/,
  /:\(\)\s*\{/, // fork bomb
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  />\s*\/dev\/(sd|disk|null)?/, // writing to devices
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, // pipe-to-shell
  /\bchmod\s+-R\s+777\s+\//,
];

// Shell metacharacters mean describe() can't enumerate what will change. Includes quotes, backslash,
// tilde, and newlines/returns so a quote- or newline-obfuscated command is flagged "can't predict".
// Exported for bashTest.
export const SHELL_META = /[|&;<>$`(){}\[\]*?'"\\~\n\r]|\$\(/;

// Fold away the obfuscation that would otherwise hide a catastrophic command from the denylist:
// strip quotes/backticks (so `rm -rf "$HOME"` reads like `rm -rf $HOME`) and collapse any run of
// whitespace — including newlines — to single spaces.
function normalize(command: string): string {
  return command.replace(/['"`]/g, "").replace(/\s+/g, " ").trim();
}

// A recursive AND forced rm aimed at a catastrophic target — the filesystem root, the home directory
// (~ / $HOME / ${HOME}), any absolute path, or a parent-directory escape (..). Flag order and long
// forms don't matter; runs on the normalized command. This closes the `rm -fr`, `rm -r -f`,
// `rm --recursive --force`, quoted-flag, and $HOME/~ gaps the old single regex missed.
function isCatastrophicRm(norm: string): boolean {
  if (!/(^|\s)rm(\s|$)/.test(norm)) return false;
  const recursive = /(^|\s)-[a-z]*r[a-z]*(\s|$)/i.test(norm) || /(^|\s)--recursive(\s|$)/.test(norm);
  const force = /(^|\s)-[a-z]*f[a-z]*(\s|$)/i.test(norm) || /(^|\s)--force(\s|$)/.test(norm);
  if (!(recursive && force)) return false;
  // target: an absolute path, home, or a parent-dir escape ".." as a path segment (but NOT "./x").
  const absoluteOrHome = /(^|\s)(\/|~|\$\{?HOME\}?)/.test(norm);
  const parentEscape = /(^|\/|\s)\.\.(\/|\s|$)/.test(norm);
  return absoluteOrHome || parentEscape;
}

// The single catastrophic-command gate used by run() (post-approval hard block) — never spawns.
// Exported so bashTest locks it directly.
export function isDenied(command: string): boolean {
  const norm = normalize(command);
  return DENY.some((re) => re.test(norm)) || isCatastrophicRm(norm);
}

// The advertised "sandboxed to the workspace" guarantee is only the child's cwd — an absolute path
// argument or a `..` escape leaves it. describe() has no access to ctx.roots, so it treats ANY
// absolute-path argument or parent-directory escape as out-of-scope (the safe direction): the action
// is shown as unpredictable and always gates (bash is gated + reversibility "unknown", so it can
// never auto-approve). Exported for bashTest.
export function looksOutOfScope(command: string): boolean {
  const norm = normalize(command);
  return /(^|\/|\s)\.\.(\/|\s|$)/.test(norm) || /(^|\s)(\/|~|\$\{?HOME\}?)/.test(norm);
}

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
    const outOfScope = looksOutOfScope(a.command);
    const unpredictable = SHELL_META.test(a.command) || outOfScope;
    return {
      action: unpredictable
        ? "Run a command I can't fully predict"
        : `Run "${programOf(a.command)}"`,
      detail: a.command,
      consequences: outOfScope
        ? "This looks like it reaches outside your workspace folder, so I can't predict or undo what it changes."
        : unpredictable
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
      if (isDenied(a.command)) {
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
          bytes: Buffer.byteLength(out) + Buffer.byteLength(err), // true UTF-8 bytes (each accumulator <= OUTPUT_CAP)
          error: code === 0 ? undefined : `exit_${code}`,
        });
      });
    }),
};
