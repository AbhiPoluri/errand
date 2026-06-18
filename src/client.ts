// Transport only: the OpenAI SDK pointed at OpenRouter. This handles HTTP, auth,
// JSON, streaming, and retries. Nothing about the *agent* lives here.
import OpenAI from "openai";
import { config } from "./config.ts";

// Build a client for ANY OpenAI-compatible endpoint — OpenRouter (cloud), a local Ollama
// server, or any compatible baseURL. The attribution headers are harmless on other servers.
export function makeClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({
    baseURL,
    apiKey: apiKey || "unused", // local servers ignore it, but the SDK requires a non-empty value
    defaultHeaders: {
      "HTTP-Referer": config.appReferer,
      "X-Title": config.appTitle,
    },
  });
}

// Default client (OpenRouter). Used by embeddings + dreaming regardless of the agent's endpoint.
export const client = makeClient(config.baseURL, config.apiKey);
