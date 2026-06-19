// Session — owns multi-turn state. The messages array is NEVER recreated per turn
// (that was the bug in the early sketch). One Session per conversation/run.
import type OpenAI from "openai";
import { Journal } from "./journal.ts";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class Session {
  readonly id: string;
  readonly messages: Message[] = [];
  readonly journal = new Journal(); // reversibility lives with the conversation

  constructor(systemPrompt: string, id = crypto.randomUUID()) {
    this.id = id;
    this.messages.push({ role: "system", content: systemPrompt });
  }

  pushUser(content: string): void {
    this.messages.push({ role: "user", content });
  }

  // Give the model EYES: append the page screenshot as an image the model can actually look at
  // (used after browser actions when a vision-capable model is selected). To control cost + context,
  // only the LATEST screenshot is kept — any earlier image message is collapsed to a text placeholder
  // (the model has its text observations for history; stale pixels aren't worth the tokens).
  pushUserImage(text: string, imageDataUrl: string): void {
    for (const m of this.messages) {
      if (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
        (m as { content: unknown }).content = "(an earlier screenshot — see the latest one below)";
      }
    }
    this.messages.push({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    });
  }

  // The assistant message from a completion (content may be null when only tool_calls).
  pushAssistant(message: Message): void {
    this.messages.push(message);
  }

  // Every tool_call id MUST get a matching tool result or the next request 400s.
  pushToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }

  // Replace all messages (used to rehydrate a persisted conversation from the DB).
  loadMessages(messages: Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
  }
}

// Return a 400-SAFE COPY of `messages`: every assistant tool_call lacking a matching tool result
// gets a synthetic placeholder result inserted right after its assistant message. Persisting a
// mid-turn checkpoint built from this guarantees the saved array never strands a tool_call — which
// would 400 the next request when the run is resumed. PURE: never mutates the input (the live
// in-loop array has its own end-of-turn backfill; this one is for the durable snapshot).
// ASSUMES tool_call ids are UNIQUE across the array (the loop's own invariant — `parallel_tool_calls`
// is off and ids come straight from the model). A duplicate/empty id reused across assistant messages
// could still strand a call here, but such output already 400s the LIVE request path, so it's a
// pre-existing model-compliance issue, not one this snapshot introduces.
export function backfillToolResults(messages: Message[]): Message[] {
  const haveResult = new Set(
    messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id?: string }).tool_call_id),
  );
  const out: Message[] = [];
  for (const m of messages) {
    out.push(m);
    const calls = (m as { tool_calls?: { id: string }[] }).tool_calls;
    if (m.role === "assistant" && Array.isArray(calls)) {
      for (const c of calls) {
        if (!haveResult.has(c.id)) {
          out.push({ role: "tool", tool_call_id: c.id, content: '{"ok":false,"error":"interrupted"}' } as Message);
          haveResult.add(c.id);
        }
      }
    }
  }
  return out;
}
