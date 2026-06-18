// Transport only: the OpenAI SDK pointed at OpenRouter. This handles HTTP, auth,
// JSON, streaming, and retries. Nothing about the *agent* lives here.
import OpenAI from "openai";
import { config } from "./config.ts";

// Build a client for ANY OpenAI-compatible endpoint — OpenRouter (cloud), a local Ollama
// server, or any compatible baseURL. The attribution headers are harmless on other servers.
// The SDK's default request timeout is 10 minutes — far too long for a calm app (a wedged
// endpoint would sit "working" for ten minutes). Cap it so create()/connect can't hang that long;
// the per-stream idle watchdog in the loop handles a connection that stalls AFTER first byte.
const CLIENT_TIMEOUT_MS = Number(process.env.CLIENT_TIMEOUT_MS) || 120_000;

export function makeClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({
    baseURL,
    apiKey: apiKey || "unused", // local servers ignore it, but the SDK requires a non-empty value
    timeout: CLIENT_TIMEOUT_MS,
    // The agent loop owns retry+backoff (with a user-visible "Reconnecting…" beat and a
    // don't-retry-after-output guard the SDK can't know about). Disable the SDK's own 2 retries so
    // the two layers don't compound into ~9 HTTP requests for one transient failure.
    maxRetries: 0,
    defaultHeaders: {
      "HTTP-Referer": config.appReferer,
      "X-Title": config.appTitle,
    },
  });
}

// Default client (OpenRouter). Used by embeddings + dreaming regardless of the agent's endpoint.
export const client = makeClient(config.baseURL, config.apiKey);
