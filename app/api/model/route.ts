// GET /api/model — the model new runs use + the preset choices. POST /api/model — switch it
// (persisted in settings; takes effect on the next run, no restart). Any OpenRouter model id
// is accepted; presets are just the easy path.
import { NextRequest, NextResponse } from "next/server";
import { config } from "../../../src/config.ts";
import { MODEL_PRESETS } from "../../../src/models.ts";
import { getSetting, setSetting } from "../../../src/server/store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    current: getSetting("model", config.model),
    default: config.model,
    presets: MODEL_PRESETS,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!model) return NextResponse.json({ error: "Pick or enter a model." }, { status: 400 });
  if (model.length > 200) return NextResponse.json({ error: "That model id is too long." }, { status: 400 });
  setSetting("model", model);
  return NextResponse.json({ ok: true, current: model });
}
