// Verifies the v7 capability-pack layer: buildRegistryFor() assembles exactly the requested,
// available packs (base tools always on, unknown ids ignored), and requiresEnv gates a pack
// in/out through the assembler. Pure logic — no network. Run: `npm run cap:test`.
import { z } from "zod";
import { buildRegistryFor, CAPABILITIES, DEFAULT_PACKS, isAvailable, availablePackIds, enabledPacks } from "./capabilities/index.ts";
import type { Capability } from "./capabilities/types.ts";
import type { Registry, Tool } from "./tools/index.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}
const names = (reg: Registry): Set<string> => new Set(reg.schemas().map((s) => s.function.name));

// A throwaway gated pack to exercise requiresEnv through buildRegistryFor.
const gatedTool: Tool<Record<string, never>> = {
  name: "gated_tool",
  modelDescription: "test",
  jsonSchema: { type: "object" },
  argsSchema: z.object({}),
  gated: false,
  describe: () => ({ action: "test", reversibility: "reversible" }),
  summarize: () => "test",
  run: async () => ({ ok: true }),
};
const gatedPack: Capability = {
  id: "gated",
  label: "Gated",
  description: "needs a key",
  tools: [gatedTool],
  requiresEnv: ["CAP_TEST_KEY"],
};

function main(): void {
  // Default set assembles every no-auth pack + the base tool.
  const all = names(buildRegistryFor(DEFAULT_PACKS));
  check("default: base get_date present", all.has("get_date"));
  check("default: files tools present", all.has("read_file") && all.has("list_files"));
  check("default: web tools present", all.has("web_search") && all.has("web_fetch"));
  check("default: browser tools present", all.has("browser_navigate"));
  check("default: memory tool present", all.has("remember"));

  // Selecting one pack includes ONLY that pack (plus base) — proves real isolation.
  const filesOnly = names(buildRegistryFor(["files"]));
  check("files-only: has read_file + base", filesOnly.has("read_file") && filesOnly.has("get_date"));
  check("files-only: NO web tools", !filesOnly.has("web_search"));
  check("files-only: NO browser tools", !filesOnly.has("browser_navigate"));
  check("files-only: NO memory tool", !filesOnly.has("remember"));

  // Unknown id and empty selection both yield just the base tools.
  check("unknown id ignored → only base", [...names(buildRegistryFor(["nope"]))].join() === "get_date");
  check("empty selection → only base", [...names(buildRegistryFor([]))].join() === "get_date");

  // requiresEnv gating through buildRegistryFor.
  delete process.env.CAP_TEST_KEY;
  check("gated pack unavailable when env unset", !isAvailable(gatedPack));
  check("gated pack skipped by assembler when env unset", !names(buildRegistryFor(["gated"], [gatedPack])).has("gated_tool"));
  process.env.CAP_TEST_KEY = "present";
  check("gated pack available when env set", isAvailable(gatedPack));
  check("gated pack included by assembler when env set", names(buildRegistryFor(["gated"], [gatedPack])).has("gated_tool"));
  delete process.env.CAP_TEST_KEY;

  // Pack registry hygiene.
  const ids = CAPABILITIES.map((c) => c.id);
  check("pack ids are unique", new Set(ids).size === ids.length);
  check("every pack has ≥1 tool + a label", CAPABILITIES.every((c) => c.tools.length > 0 && !!c.label));
  check("DEFAULT_PACKS all exist as packs", DEFAULT_PACKS.every((id) => ids.includes(id)));
  check("no-auth packs all available", availablePackIds().sort().join() === [...DEFAULT_PACKS].sort().join());

  // enabledPacks: user's saved set, 'files' always forced on, unset → defaults, unknown dropped.
  check("enabledPacks('') → DEFAULT_PACKS", enabledPacks("").sort().join() === [...DEFAULT_PACKS].sort().join());
  check("enabledPacks('files') → only files (others off)", enabledPacks("files").join() === "files");
  check("enabledPacks('web') forces files on", new Set(enabledPacks("web")).has("files") && new Set(enabledPacks("web")).has("web"));
  check("enabledPacks drops unknown ids", !enabledPacks("files,bogus").includes("bogus"));
  check(
    "buildRegistryFor(enabledPacks('files')) → files+base only, no web",
    (() => {
      const n = names(buildRegistryFor(enabledPacks("files")));
      return n.has("read_file") && n.has("get_date") && !n.has("web_search");
    })(),
  );

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

main();
