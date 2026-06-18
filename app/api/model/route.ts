// GET /api/model — the model + endpoint new runs use, plus the choices. POST — switch either
// (persisted in settings; takes effect on the next run, no restart). Any OpenRouter model id is
// accepted; presets are the easy path. The OpenRouter API key never leaves the server.
import { NextRequest, NextResponse } from "next/server";
import { config } from "../../../src/config.ts";
import { MODEL_PRESETS, ENDPOINTS, listOllamaModels, normalizeOllamaBaseUrl, DEFAULT_OLLAMA_BASE_URL } from "../../../src/models.ts";
import { getSetting, setSetting } from "../../../src/server/store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Ollama server new runs target — the user's saved URL (Settings) or the localhost default.
function ollamaBaseUrl(): string {
  return normalizeOllamaBaseUrl(getSetting("ollamaBaseUrl", "")) ?? DEFAULT_OLLAMA_BASE_URL;
}

export async function GET() {
  const ollamaUrl = ollamaBaseUrl();
  return NextResponse.json({
    current: getSetting("model", config.model),
    default: config.model,
    presets: MODEL_PRESETS,
    endpoint: getSetting("endpoint", "openrouter"),
    endpoints: ENDPOINTS.map((e) => ({ key: e.key, label: e.label, note: e.note })),
    ollamaBaseUrl: ollamaUrl,
    // Models available at the configured Ollama server (local or LAN); fail-soft [] if it's unreachable.
    ollamaModels: await listOllamaModels(1500, ollamaUrl),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (typeof body?.endpoint === "string") {
    if (!ENDPOINTS.some((e) => e.key === body.endpoint)) {
      return NextResponse.json({ error: "Unknown endpoint." }, { status: 400 });
    }
    setSetting("endpoint", body.endpoint);
  }
  if (typeof body?.model === "string") {
    const model = body.model.trim();
    if (!model) return NextResponse.json({ error: "Pick or enter a model." }, { status: 400 });
    if (model.length > 200) return NextResponse.json({ error: "That model id is too long." }, { status: 400 });
    setSetting("model", model);
  }
  if (typeof body?.ollamaBaseUrl === "string") {
    const norm = normalizeOllamaBaseUrl(body.ollamaBaseUrl);
    if (!norm) {
      return NextResponse.json(
        { error: "That doesn't look like a server URL. Use e.g. http://192.168.86.237:11434" },
        { status: 400 },
      );
    }
    setSetting("ollamaBaseUrl", norm);
  }
  return NextResponse.json({
    ok: true,
    current: getSetting("model", config.model),
    endpoint: getSetting("endpoint", "openrouter"),
    ollamaBaseUrl: ollamaBaseUrl(),
  });
}
