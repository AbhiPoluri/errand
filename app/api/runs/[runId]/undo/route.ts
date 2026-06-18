// POST /api/runs/:runId/undo — reverse every reversible change this run made.
import { NextRequest, NextResponse } from "next/server";
import { undoRun } from "../../../../../src/server/runRegistry.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { runId: string } }) {
  const result = await undoRun(params.runId);
  if (!result) return NextResponse.json({ error: "run not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...result });
}
