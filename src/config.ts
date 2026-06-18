// Central config: env loading + constants. No secrets are ever logged.
import process from "node:process";

// Node 24 loads .env natively — no dotenv dependency (stays "from scratch").
try {
  process.loadEnvFile();
} catch {
  // .env optional if vars are already in the environment
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name} (set it in .env)`);
  }
  return v;
}

export const config = {
  apiKey: required("OPENROUTER_API_KEY"),
  // Model is user-selectable (Settings). Build/test default = fast DeepSeek V4 Flash.
  model: process.env.MODEL ?? "deepseek/deepseek-v4-flash:nitro",
  baseURL: "https://openrouter.ai/api/v1",
  // OpenRouter attribution headers (cosmetic). Header name to be verified against
  // OpenRouter docs — see PLAN.md §7 open items.
  appTitle: "agent-harness",
  appReferer: "https://github.com/local/agent-harness",
  // Sandbox root for file/shell tools (v2+). Everything destructive is confined here.
  workspaceRoot: process.env.WORKSPACE_ROOT ?? `${process.cwd()}/workspace`,
  // Where saved skills (named, reusable SKILL.md procedures) live. App-managed, not a user folder.
  skillsRoot: process.env.ERRAND_SKILLS ?? `${process.cwd()}/skills`,
} as const;
