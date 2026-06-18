// GET  /api/dream — { enabled, lastDream }
// POST /api/dream — { enabled: bool } to toggle, or { now: true } to dream immediately.
import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "../../../src/server/store.ts";
import { dream } from "../../../src/server/dream.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    enabled: getSetting("dreaming") === "on",
    lastDream: Number(getSetting("lastDream") || "0"),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (typeof body?.enabled === "boolean") {
    setSetting("dreaming", body.enabled ? "on" : "off");
    return NextResponse.json({ enabled: body.enabled });
  }
  if (body?.now) {
    const result = await dream();
    return NextResponse.json({ ok: true, ...result });
  }
  return NextResponse.json({ error: "nothing to do" }, { status: 400 });
}
