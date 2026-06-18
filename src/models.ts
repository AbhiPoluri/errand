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
  requestTimeoutMs?: number; // per-endpoint request cap (a big local model can take longer than cloud)
}

// The Ollama base URL Errand uses when no custom one is saved. The user can repoint this in
// Settings → Model (e.g. at a beefier box on the LAN — a Mac Studio at http://192.168.86.237:11434/v1).
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

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
    label: "Ollama (local or LAN)",
    baseURL: DEFAULT_OLLAMA_BASE_URL,
    apiKey: "ollama",
    stream: false,
    note: "Ollama on this machine or another on your network — small models are hit-or-miss at tool use",
    // Bigger local models are slower than cloud, and the non-streamed path has no idle watchdog —
    // give a generous cap so a long local generation isn't severed (unreachable hosts fail fast via
    // the pre-flight reachability probe in runRegistry, so this only ever bounds a *reachable* server).
    requestTimeoutMs: 300_000,
  },
];

// Validate + canonicalize a user-entered Ollama server URL to the OpenAI-compatible base `…/v1`.
// Accepts bare hosts ("http://192.168.86.237:11434") or full "…/v1" forms; ignores any stray path so
// the value is always safe to hand to the SDK and to derive `/api/tags` from. Returns null on garbage
// so callers can reject it. No host allow-listing on purpose: pointing at any machine the user owns
// (localhost, a .local hostname, a LAN IP) is the whole feature — this is a single-user local tool.
export function normalizeOllamaBaseUrl(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  // Parse leniently: a non-technical user may type just "192.168.86.237:11434" or "localhost:11434"
  // with no scheme. Only prepend http:// when there's no explicit "scheme://" already — prefixing a
  // value that DOES carry a scheme (e.g. "ftp://host") would otherwise yield a bogus "http://ftp//…".
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  let u: URL;
  try {
    u = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Reject a hostname that isn't a plausible host/IP — the lenient http:// prefix would otherwise
  // accept nonsense like "!!!". Allows IPv4/hostnames (letters, digits, dots, hyphens, underscores)
  // and bracketed IPv6 ([::1]); anything else is a typo, not a server.
  if (!/^[a-zA-Z0-9._\-[\]:]+$/.test(u.hostname)) return null;
  // Canonical OpenAI-compatible base = origin + path with a single trailing "/v1". Keep any non-/v1
  // path so a reverse-proxied Ollama (e.g. http://nas.local/ollama/v1) survives; drop query/hash.
  const path = u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${u.origin}${path}/v1`;
}

// Detect the Ollama models available at `baseURL` (defaults to the Ollama endpoint's configured URL)
// via Ollama's `GET /api/tags`. Fail-soft and fast: if Ollama isn't running (or is slow/unreachable),
// returns [] within a short timeout rather than hanging the caller. The tags endpoint lives at the
// host root (/api/tags), not under the OpenAI-compat /v1.
export async function listOllamaModels(timeoutMs = 1000, baseURL?: string): Promise<string[]> {
  const base = baseURL ?? ENDPOINTS.find((e) => e.key === "ollama")?.baseURL;
  if (!base) return [];
  const tagsUrl = base.replace(/\/v1\/?$/, "") + "/api/tags";
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
