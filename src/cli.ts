// CLI sink + REPL. This is the FIRST of two renderers (the web/SSE sink comes in v4).
// Its existence proves the loop is UI-agnostic: it only consumes AgentEvents.
import readline from "node:readline";
import { config } from "./config.ts";
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Registry } from "./tools/index.ts";
import { getDate } from "./tools/getDate.ts";
import { echo } from "./tools/echo.ts";
import { bash } from "./tools/bash.ts";
import { fileTools } from "./tools/files.ts";
import { AgentRunner } from "./loop.ts";
import { CliApprovalGate } from "./approvals.ts";
import type { AgentEvent, EventSink } from "./events.ts";

const SYSTEM = [
  "You are Errand, a calm, friendly helper for non-technical people.",
  "Keep replies short and in plain language — no jargon, no code, no file paths unless asked.",
  "Never use emojis.",
  "Use the available tools when they help answer; otherwise just reply directly.",
].join(" ");

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;
const out = (s: string) => process.stdout.write(s);

// Render each AgentEvent for the terminal. The exhaustive switch (the `never` default)
// guarantees this renderer handles every event the protocol can produce.
class CliSink implements EventSink {
  emit(e: AgentEvent): void {
    switch (e.type) {
      case "run.started":
        out("\n" + dim(`> ${e.title}`) + "\n");
        break;
      case "user.message":
        break; // shown by the web transcript; CLI already echoed the prompt
      case "turn.started":
        break;
      case "thinking.summary":
        out(dim(`  · ${e.summary}`) + "\n");
        break;
      case "message.delta":
        break; // streamed tokens: rendered live by the web UI, not the CLI
      case "message.completed":
        out("\n" + e.text + "\n");
        break;
      case "message.refusal":
        out("\n" + e.text + "\n");
        break;
      case "tool.proposed":
        out(dim(`  -> ${e.action}`) + "\n");
        break;
      case "approval.required":
        out(amber(`  [needs your okay] ${e.action}`) + "\n");
        break;
      case "tool.started":
        break;
      case "screenshot":
        break; // live browser view is a web-UI concern
      case "tool.result":
        out((e.ok ? dim(`  [ok] ${e.summary}`) : red(`  [x] ${e.summary}`)) + "\n");
        break;
      case "approval.resolved":
        break;
      case "run.error":
        out(amber(`  ! ${e.userMessage}`) + "\n");
        break;
      case "run.finished":
        break;
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }
}

async function main() {
  const runId = crypto.randomUUID();
  const session = new Session(SYSTEM);
  const logger = new Logger(runId);
  const registry = new Registry().register(getDate).register(echo).register(bash);
  for (const t of fileTools) registry.register(t);

  out(`Errand harness — CLI sink\n`);
  out(dim(`model: ${config.model}  ·  workspace: ${config.workspaceRoot}`) + "\n");
  out(dim(`trace: logs/run-${runId}.jsonl`) + "\n");
  out(dim(`Type a message. Ctrl-C cancels a running task (press again at the prompt to quit).`) + "\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\nyou > " });
  const gate = new CliApprovalGate(rl);
  const runner = new AgentRunner({ session, sink: new CliSink(), registry, model: config.model, logger, runId, gate });
  let active: AbortController | null = null;

  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) return rl.prompt();
    active = new AbortController();
    try {
      await runner.send(input, active.signal);
    } catch (err) {
      out(red(`\n[internal] ${String(err)}`) + "\n");
      logger.log("internal_error", String((err as any)?.stack ?? err));
    } finally {
      active = null;
      rl.prompt();
    }
  });
  rl.on("SIGINT", () => {
    if (active) {
      active.abort();
    } else {
      rl.close();
    }
  });
  rl.on("close", () => process.exit(0));
}

main();
