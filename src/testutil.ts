// Shared test helpers. Kept side-effect free (no top-level main()) so any test file can
// import from it without accidentally running another suite.
import type OpenAI from "openai";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// THE INVARIANT: every assistant tool_call id must have a matching tool result somewhere
// after it, or the next API request 400s. Used across the loop/session test suites.
export function wellFormed(messages: Msg[]): { ok: boolean; detail: string } {
  const resultIds = new Set(messages.filter((m) => m.role === "tool").map((m: any) => m.tool_call_id));
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
      for (const c of (m as any).tool_calls) {
        if (!resultIds.has(c.id)) return { ok: false, detail: `no result for tool_call ${c.id}` };
      }
    }
  }
  return { ok: true, detail: "every tool_call has a result" };
}
