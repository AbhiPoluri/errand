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
