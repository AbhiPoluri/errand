// Capability check: does the configured model support tool calling?
// OpenRouter's /models endpoint exposes supported_parameters per model.
// "OpenAI-compatible" is one interface, not one behavior — verify before v1.
import { config } from "./config.ts";

async function main() {
  const res = await fetch(`${config.baseURL}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`models list failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    data: Array<{
      id: string;
      context_length?: number;
      supported_parameters?: string[];
    }>;
  };

  // model can be passed as argv[2]; routing suffixes like :nitro/:floor are not
  // distinct list entries, so match the base id (strip a trailing :variant).
  const target = process.argv[2] ?? config.model;
  const base = target.replace(/:(nitro|floor|online)$/i, "");
  const m = data.data.find((x) => x.id === target || x.id === base);
  if (!m) {
    console.log(`[check] model ${target} NOT found in list (base: ${base})`);
    const term = base.split("/").pop()!.split("-")[0];
    const near = data.data.filter((x) => x.id.includes(term)).map((x) => x.id);
    console.log(`[check] '${term}'-ish slugs available:`, near.slice(0, 12));
    return;
  }

  const params = m.supported_parameters ?? [];
  console.log(`[check] model: ${m.id}`);
  console.log(`[check] context_length: ${m.context_length ?? "?"}`);
  console.log(`[check] supports tools: ${params.includes("tools")}`);
  console.log(`[check] supports tool_choice: ${params.includes("tool_choice")}`);
  console.log(`[check] supported_parameters: ${params.join(", ")}`);
}

main().catch((err) => {
  console.error("[check] ERROR:", err?.message ?? err);
  process.exit(1);
});
