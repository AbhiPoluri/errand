// GET /api/capabilities — the inventory of what Errand can do (for the Settings transparency
// panel). POST {id, enabled} — turn a capability pack on/off for future runs. 'files' is the
// core surface and can't be turned off.
import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES, enabledPacks, isAvailable } from "../../../src/capabilities/index.ts";
import * as store from "../../../src/server/store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const enabled = new Set(enabledPacks(store.getSetting("packs")));
  const packs = CAPABILITIES.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    enabled: enabled.has(c.id),
    available: isAvailable(c),
    required: c.id === "files",
  }));
  return NextResponse.json({ packs });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id : "";
  const enabled = !!body?.enabled;
  if (!id || !CAPABILITIES.some((c) => c.id === id)) {
    return NextResponse.json({ error: "unknown capability" }, { status: 400 });
  }
  if (id === "files") {
    return NextResponse.json({ error: "the Files capability can't be turned off" }, { status: 400 });
  }
  const set = new Set(enabledPacks(store.getSetting("packs")));
  if (enabled) set.add(id);
  else set.delete(id);
  set.add("files"); // belt-and-braces
  store.setSetting("packs", [...set].join(","));
  return NextResponse.json({ ok: true, packs: [...set] });
}
