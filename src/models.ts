// Curated model presets for the in-app switcher. All are tool-capable on OpenRouter (verified
// 2026-06-17 against /api/v1/models — Errand's agent needs tool calling). The user can also
// type any OpenRouter model id; presets are just the easy path. Order = fast/cheap → strong.
export interface ModelPreset {
  id: string;
  label: string;
  note: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  { id: "deepseek/deepseek-v4-flash:nitro", label: "DeepSeek V4 Flash", note: "Fast and low-cost — the default" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast, capable" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini", note: "Balanced" },
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", note: "Best quality — slower, pricier" },
];
