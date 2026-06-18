// Transport only: the OpenAI SDK pointed at OpenRouter. This handles HTTP, auth,
// JSON, streaming, and retries. Nothing about the *agent* lives here.
import OpenAI from "openai";
import { config } from "./config.ts";

export const client = new OpenAI({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
  defaultHeaders: {
    "HTTP-Referer": config.appReferer,
    "X-Title": config.appTitle,
  },
});
