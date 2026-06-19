// Direct unit test for backfillToolResults (src/session.ts) — the 400-safety snapshot helper that
// inserts a placeholder tool result for any assistant tool_call left without one. It's only exercised
// INDIRECTLY via resumeTest, so its dedup + multi-strand branches aren't pinned. Pure, offline, no DB.
// Run: `npm run session:test`.
import type OpenAI from "openai";
import { backfillToolResults } from "./session.ts";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const asst = (calls: string[]): Msg =>
  ({ role: "assistant", content: null, tool_calls: calls.map((id) => ({ id, type: "function", function: { name: "do", arguments: "{}" } })) }) as Msg;
const toolMsg = (id: string): Msg => ({ role: "tool", tool_call_id: id, content: "{}" }) as Msg;
const isPlaceholder = (m: Msg, id: string) =>
  (m as any).role === "tool" && (m as any).tool_call_id === id && /interrupted/.test((m as any).content);

// (a) a fully-resolved array is returned unchanged (same refs, no extra rows)
{
  const input: Msg[] = [{ role: "user", content: "hi" } as Msg, asst(["c1"]), toolMsg("c1")];
  const out = backfillToolResults(input);
  check("fully-resolved: length unchanged", out.length === 3, `${out.length}`);
  check("fully-resolved: messages identical (no rewrite)", out.every((m, i) => m === input[i]));
}

// (b) one stranded call -> exactly one placeholder, right after its assistant message
{
  const out = backfillToolResults([asst(["c1"])]);
  check("one stranded call -> +1 message", out.length === 2, `${out.length}`);
  check("placeholder follows the assistant msg, for c1", isPlaceholder(out[1], "c1"));
}

// (c) two stranded calls in one assistant message -> two placeholders, in call order
{
  const out = backfillToolResults([asst(["c1", "c2"])]);
  check("two stranded calls -> +2 messages", out.length === 3, `${out.length}`);
  check("both placeholders present, in order", isPlaceholder(out[1], "c1") && isPlaceholder(out[2], "c2"));
}

// (d) an already-resolved call must NOT get a duplicate placeholder (the haveResult dedup branch)
{
  const out = backfillToolResults([asst(["c1", "c2"]), toolMsg("c1")]); // c1 resolved, c2 stranded
  check("mixed: only the unresolved call is backfilled (+1)", out.length === 3, `${out.length}`);
  check("no duplicate result for the already-resolved c1", out.filter((m) => (m as any).tool_call_id === "c1").length === 1);
  check("the stranded c2 got its placeholder", out.some((m) => isPlaceholder(m, "c2")));
}

// (e) PURE: the input array is never mutated
{
  const input: Msg[] = [asst(["c1"])];
  backfillToolResults(input);
  check("input array is not mutated", input.length === 1);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
