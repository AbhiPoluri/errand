// POST /api/runs/:runId/message — send the next user turn into the same Session.
import { NextRequest, NextResponse } from "next/server";
import { sendMessage } from "../../../../../src/server/runRegistry.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const body = await req.json().catch(() => ({}));
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
  const result = await sendMessage(params.runId, message);
  if (result === "missing") return NextResponse.json({ error: "run not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
