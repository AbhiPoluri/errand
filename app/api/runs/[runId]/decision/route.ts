// POST /api/runs/:runId/decision — resolve a parked approval. Body: { callId, decision }.
import { NextRequest, NextResponse } from "next/server";
import { decide, approveAlways } from "../../../../../src/server/runRegistry.ts";
import type { Decision } from "../../../../../src/approvals.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "approved_always" = approve this + auto-approve future REVERSIBLE actions this errand.
const ALLOWED = ["approved", "denied", "cancelled", "expired", "approved_always"] as const;

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const body = await req.json().catch(() => ({}));
  const callId = typeof body?.callId === "string" ? body.callId : "";
  const decision = body?.decision as (typeof ALLOWED)[number];
  if (!callId || !ALLOWED.includes(decision)) {
    return NextResponse.json({ error: "callId and a valid decision required" }, { status: 400 });
  }
  const ok =
    decision === "approved_always"
      ? approveAlways(params.runId, callId)
      : decide(params.runId, callId, decision as Decision);
  return NextResponse.json({ ok });
}
