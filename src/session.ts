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
