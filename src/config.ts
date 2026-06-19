// Central config: env loading + constants. No secrets are ever logged.
import process from "node:process";
import { workspaceRoot, skillsRoot } from "./paths.ts";

// Node 24 loads .env natively — no dotenv dependency (stays "from scratch").
try {
  process.loadEnvFile();
} catch {
  // .env optional if vars are already in the environment
}

export const config = {
  // The OpenRouter key is NO LONGER required at import. config.ts sits on every route's import path,
  // so a throw here bricked EVERY route at boot with an unstyled 500 the moment the key was absent —
  // unacceptable for a packaged app whose key lives in OS secure storage, not a .env beside cwd.
  // It's read soft now; the run path pre-flights hasApiKey() and surfaces a calm "add your key"
  // message, and a host (Electron main) injects the key into the env before the first request.
  // Empty string = not configured. Embeddings/dreaming already fail soft (→ null) without it.
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  // Model is user-selectable (Settings). Build/test default = fast DeepSeek V4 Flash.
  model: process.env.MODEL ?? "deepseek/deepseek-v4-flash:nitro",
  baseURL: "https://openrouter.ai/api/v1",
  // OpenRouter attribution headers (cosmetic). Header name to be verified against
  // OpenRouter docs — see PLAN.md §7 open items.
  appTitle: "agent-harness",
  appReferer: "https://github.com/local/agent-harness",
  // Sandbox root for file/shell tools (v2+). Everything destructive is confined here. Resolved via
  // paths.ts (ERRAND_DATA-derived) so a host can repoint all app data with one env var.
  workspaceRoot: workspaceRoot(),
  // Where saved skills (named, reusable SKILL.md procedures) live. App-managed, not a user folder.
  skillsRoot: skillsRoot(),
} as const;

// Whether the cloud (OpenRouter) path is usable. The run-start pre-flight calls this so a missing
// key becomes a calm, actionable message instead of a 401 mid-run (or a boot crash, as before).
export function hasApiKey(): boolean {
  return !!config.apiKey;
}
