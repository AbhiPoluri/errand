// POST /api/ext/result — the extension reports a command's result here. Body: { id, result }.
import { NextRequest, NextResponse } from "next/server";
import { resolveResult } from "../../../../src/server/extension.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

const MAX_BODY = 2_000_000; // 2MB — this is an open (CORS *) POST that feeds the agent's tool-result path

export async function POST(req: NextRequest) {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413, headers: CORS });
  }
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413, headers: CORS });
  }
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* malformed → treated as empty */
  }
  const ok = typeof body?.id === "string" ? resolveResult(body.id, body.result) : false;
  return NextResponse.json({ ok }, { headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: { ...CORS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
  });
}
