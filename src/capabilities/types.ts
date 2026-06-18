// The capability-pack contract. A pack bundles a domain's tools under a stable id + a
// human label, optionally gated on the environment it needs (an API key / OAuth token).
// Kept in its own file so pack files and the assembler can both import the type without a
// runtime import cycle.
import type { Tool } from "../tools/index.ts";

export interface Capability {
  id: string; // stable identifier ("files", "web", "browser", "memory", later "gmail")
  label: string; // human name, for a future capabilities screen
  description: string; // plain-language "what this lets Errand do"
  tools: Tool<any>[]; // the tools this pack contributes to the registry
  // Env vars that MUST be present for the pack to be offered at all (e.g. an OAuth token).
  // A pack missing any of these is skipped entirely — the model is never shown a tool that
  // can't actually run. Omit for no-auth packs.
  requiresEnv?: string[];
}
