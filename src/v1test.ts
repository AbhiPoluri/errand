// Non-interactive smoke test for the v1 loop: drives a few turns through the same
// Session (multi-turn memory), exercising tool calls, a plain reply, and arg validation.
import { config } from "./config.ts";
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Registry } from "./tools/index.ts";
import { getDate } from "./tools/getDate.ts";
import { echo } from "./tools/echo.ts";
import { AgentRunner } from "./loop.ts";
import type { AgentEvent, EventSink } from "./events.ts";

class TapSink implements EventSink {
  emit(e: AgentEvent): void {
    if (e.type === "tool.proposed") console.log(`   [tool] ${e.action}`);
    else if (e.type === "tool.result") console.log(`   [${e.ok ? "ok" : "x"}] ${e.summary}`);
    else if (e.type === "thinking.summary") console.log(`   [think] ${e.summary}`);
    else if (e.type === "message.completed") console.log(`   [reply] ${e.text}`);
    else if (e.type === "run.error") console.log(`   [!] (${e.kind}) ${e.userMessage}`);
  }
}

const SYSTEM =
  "You are Errand, a calm helper for non-technical people. Keep replies short and plain. Never use emojis. Use tools when they help.";

async function main() {
  const runId = crypto.randomUUID();
  const session = new Session(SYSTEM);
  const runner = new AgentRunner({
    session,
    sink: new TapSink(),
    registry: new Registry().register(getDate).register(echo),
    model: config.model,
    logger: new Logger(runId),
    runId,
  });

  const prompts = [
    "What's today's date?",
    "Now echo the word: banana",
    "Thanks! In one short sentence, what can you help me with?",
  ];

  for (const p of prompts) {
    console.log(`\nyou > ${p}`);
    const ac = new AbortController();
    await runner.send(p, ac.signal);
  }
  console.log(`\n(trace: logs/run-${runId}.jsonl, messages in session: ${session.messages.length})`);
  process.exit(0);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});
