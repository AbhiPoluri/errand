// POST /api/ext/result — the extension reports a command's result here. Body: { id, result }.
import { NextRequest, NextResponse } from "next/server";
import { resolveResult } from "../../../../src/server/extension.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ok = typeof body?.id === "string" ? resolveResult(body.id, body.result) : false;
  return NextResponse.json({ ok }, { headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: { ...CORS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
  });
}
