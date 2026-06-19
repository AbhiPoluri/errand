// POST /api/runs/:runId/cancel — abort the current turn (kills the model call + any
// child process). A parked approval resolves to "cancelled" via the abort signal.
import { NextRequest, NextResponse } from "next/server";
import { cancelRun } from "../../../../../src/server/runRegistry.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { runId: string } }) {
  const ok = cancelRun(params.runId);
  if (!ok) return NextResponse.json({ error: "run not found" }, { status: 404 }); // match /message + /undo
  return NextResponse.json({ ok: true });
}
