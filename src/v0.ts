// v0 — transport smoke test. Send one message, print the reply. Proves the key,
// the base URL, and the model slug all work. No tools, no loop yet.
import { client } from "./client.ts";
import { config } from "./config.ts";

async function main() {
  console.log(`[v0] model: ${config.model}`);
  const res = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: "You are a terse assistant. One sentence." },
      { role: "user", content: "Say hello and name the model you are." },
    ],
  });

  const choice = res.choices[0];
  console.log(`[v0] finish_reason: ${choice.finish_reason}`);
  console.log(`[v0] reply: ${choice.message.content}`);
  if (res.usage) {
    console.log(
      `[v0] usage: prompt=${res.usage.prompt_tokens} completion=${res.usage.completion_tokens} total=${res.usage.total_tokens}`,
    );
  } else {
    console.log("[v0] usage: (not reported)");
  }
}

main().catch((err) => {
  console.error("[v0] ERROR:", err?.message ?? err);
  process.exit(1);
});
