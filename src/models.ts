// Curated model presets for the in-app switcher. All are tool-capable on OpenRouter (verified
// 2026-06-17 against /api/v1/models — Errand's agent needs tool calling). The user can also
// type any OpenRouter model id; presets are just the easy path. Order = fast/cheap → strong.
export interface ModelPreset {
  id: string;
  label: string;
  note: string;
}

// Where the agent's chat completions go. Any OpenAI-compatible endpoint works. Local models
// (Ollama) do tool-calling far more reliably NON-streamed, so they default stream:false.
export interface Endpoint {
  key: string;
  label: string;
  baseURL: string;
  apiKey?: string; // fixed key for local servers (ignored by them, but the SDK needs non-empty)
  apiKeyEnv?: string; // or read the key from this env var (cloud)
  stream: boolean;
  note: string;
}

export const ENDPOINTS: Endpoint[] = [
  {
    key: "openrouter",
    label: "OpenRouter (cloud)",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    stream: true,
    note: "Hosted models, streamed",
  },
  {
    key: "ollama",
    label: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
    stream: false,
    note: "Models on this machine — small ones are hit-or-miss at tool use",
  },
];

// Detect the Ollama models installed on THIS machine via Ollama's `GET /api/tags`. Fail-soft and
// fast: if Ollama isn't running (or is slow), returns [] within a short timeout rather than hanging
// the caller. The tags endpoint lives at the host root (/api/tags), not under the OpenAI-compat /v1.
export async function listOllamaModels(timeoutMs = 1000): Promise<string[]> {
  const ep = ENDPOINTS.find((e) => e.key === "ollama");
  if (!ep) return [];
  const tagsUrl = ep.baseURL.replace(/\/v1\/?$/, "") + "/api/tags";
  try {
    const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data: any = await res.json();
    const names = Array.isArray(data?.models)
      ? data.models
          .map((m: any) => m?.name)
          // Drop embedding models — they can't run the agent's chat/tool-calling loop, so offering
          // one as the model would just produce failed runs.
          .filter((n: any) => typeof n === "string" && n && !/embed/i.test(n))
      : [];
    return [...new Set<string>(names)];
  } catch {
    return []; // Ollama not running / unreachable — the header falls back to the documented default
  }
}

export const MODEL_PRESETS: ModelPreset[] = [
  { id: "deepseek/deepseek-v4-flash:nitro", label: "DeepSeek V4 Flash", note: "Fast and low-cost — the default" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast, capable" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini", note: "Balanced" },
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", note: "Best quality — slower, pricier" },
];
