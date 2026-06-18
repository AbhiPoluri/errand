// POST /api/runs/:runId/auto — turn the "auto-approve safe changes" toggle on/off.
// Body: { enabled: boolean }. Only ever affects REVERSIBLE actions (enforced in the loop).
import { NextRequest, NextResponse } from "next/server";
import { setAutoApprove } from "../../../../../src/server/runRegistry.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const body = await req.json().catch(() => ({}));
  const ok = setAutoApprove(params.runId, body?.enabled === true);
  return NextResponse.json({ ok });
}
