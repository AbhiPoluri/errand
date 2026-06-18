// Verifies the configurable-Ollama-endpoint layer: normalizeOllamaBaseUrl() canonicalizes user
// input to an OpenAI-compatible `…/v1` base (lenient about a missing scheme, preserving a proxy
// subpath, rejecting garbage), and the Ollama endpoint carries the per-endpoint request timeout.
// Pure logic — no network. Run: `npm run endpoint:test`.
import { normalizeOllamaBaseUrl, DEFAULT_OLLAMA_BASE_URL, ENDPOINTS } from "./models.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}
function eq(label: string, got: string | null, want: string | null): void {
  check(`${label} → ${JSON.stringify(want)} (got ${JSON.stringify(got)})`, got === want);
}

function main(): void {
  // Accepts a full URL and is idempotent on the canonical form.
  eq("full host:port", normalizeOllamaBaseUrl("http://192.168.86.237:11434"), "http://192.168.86.237:11434/v1");
  eq("already /v1 (idempotent)", normalizeOllamaBaseUrl("http://192.168.86.237:11434/v1"), "http://192.168.86.237:11434/v1");
  eq("trailing slash after /v1", normalizeOllamaBaseUrl("http://192.168.86.237:11434/v1/"), "http://192.168.86.237:11434/v1");
  eq("DEFAULT is already canonical", normalizeOllamaBaseUrl(DEFAULT_OLLAMA_BASE_URL), DEFAULT_OLLAMA_BASE_URL);

  // Lenient about a missing scheme — the natural thing a non-technical user types.
  eq("bare ip:port (no scheme)", normalizeOllamaBaseUrl("192.168.86.237:11434"), "http://192.168.86.237:11434/v1");
  eq("bare localhost:port (parses as protocol)", normalizeOllamaBaseUrl("localhost:11434"), "http://localhost:11434/v1");
  eq("surrounding whitespace trimmed", normalizeOllamaBaseUrl("  192.168.86.237:11434  "), "http://192.168.86.237:11434/v1");

  // Hostnames with hyphens / .local suffixes are valid.
  eq("hyphenated .local host", normalizeOllamaBaseUrl("http://mac-studio.local:11434"), "http://mac-studio.local:11434/v1");

  // A reverse-proxied Ollama mounted at a subpath survives (origin+path, not just origin).
  eq("reverse-proxy subpath preserved", normalizeOllamaBaseUrl("http://nas.local/ollama/v1"), "http://nas.local/ollama/v1");
  eq("subpath without /v1 gets one", normalizeOllamaBaseUrl("http://nas.local/ollama"), "http://nas.local/ollama/v1");

  // https is preserved; query/hash are dropped (a model base never needs them).
  eq("https preserved", normalizeOllamaBaseUrl("https://ollama.example.com"), "https://ollama.example.com/v1");
  eq("query + hash dropped", normalizeOllamaBaseUrl("http://host:11434/v1?x=1#y"), "http://host:11434/v1");

  // Garbage is rejected (the lenient http:// retry must not swallow nonsense hosts).
  eq("triple-bang is not a host", normalizeOllamaBaseUrl("!!!"), null);
  eq("empty string", normalizeOllamaBaseUrl(""), null);
  eq("whitespace only", normalizeOllamaBaseUrl("   "), null);
  eq("non-http scheme rejected", normalizeOllamaBaseUrl("ftp://192.168.86.237:11434"), null);
  eq("spaces inside rejected", normalizeOllamaBaseUrl("not a url"), null);

  // The Ollama endpoint template carries a generous per-endpoint request cap and stays non-streamed.
  const ollama = ENDPOINTS.find((e) => e.key === "ollama");
  check("ollama endpoint exists", !!ollama);
  check("ollama is non-streamed (tool calls reliable)", ollama?.stream === false);
  check("ollama has a per-endpoint requestTimeoutMs", typeof ollama?.requestTimeoutMs === "number" && (ollama!.requestTimeoutMs ?? 0) > 0);
  const openrouter = ENDPOINTS.find((e) => e.key === "openrouter");
  check("openrouter still streamed", openrouter?.stream === true);

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

main();
