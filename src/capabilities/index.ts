// Capability packs — the seam that makes "a new domain = one pack file" (PLAN §6b / v7).
// buildRegistryFor() assembles a tool Registry from the chosen, AVAILABLE packs. A pack that
// is missing its required env (an API key / OAuth token) is silently skipped — never
// half-wired — so the model is never offered a tool that can't actually run. Adding a domain
// (e.g. v8 Gmail) = write one pack file + add it to CAPABILITIES.
import { Registry, type Tool } from "../tools/index.ts";
import { getDate } from "../tools/getDate.ts";
import type { Capability } from "./types.ts";
import { filesPack } from "./files.ts";
import { webPack } from "./web.ts";
import { browserPack } from "./browser.ts";
import { memoryPack } from "./memory.ts";

export type { Capability } from "./types.ts";

// Tools every run gets regardless of packs — trivially safe, broadly useful.
const BASE_TOOLS: Tool<any>[] = [getDate];

// Every known pack. Adding a domain = one new pack file + one entry here.
export const CAPABILITIES: Capability[] = [filesPack, webPack, browserPack, memoryPack];

// What the web app enables by default (the no-auth consumer surface).
export const DEFAULT_PACKS = ["files", "web", "browser", "memory"] as const;

// A pack is available only if every env var it requires is set (no requiresEnv → always available).
export function isAvailable(cap: Capability): boolean {
  return (cap.requiresEnv ?? []).every((k) => !!process.env[k]);
}

export function capability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

// Ids of all currently-available packs (for a future capabilities screen / diagnostics).
export function availablePackIds(caps: Capability[] = CAPABILITIES): string[] {
  return caps.filter(isAvailable).map((c) => c.id);
}

// Assemble a Registry from the requested pack ids. Unknown ids are ignored; packs missing
// their required env are skipped. `caps` is injectable so alternate surfaces (or tests) can
// supply their own pack set.
export function buildRegistryFor(packIds: readonly string[], caps: Capability[] = CAPABILITIES): Registry {
  const reg = new Registry();
  for (const t of BASE_TOOLS) reg.register(t);
  const want = new Set(packIds);
  for (const cap of caps) {
    if (want.has(cap.id) && isAvailable(cap)) {
      for (const t of cap.tools) reg.register(t);
    }
  }
  return reg;
}
