// POST /api/runs — start a new run. Returns { runId }. The run executes server-side
// (real fs + child_process); the browser watches it via the SSE stream.
import { NextRequest, NextResponse } from "next/server";
import { startRun, listRuns } from "../../../src/server/runRegistry.ts";
import { checkRoots } from "../../../src/server/folders.ts";

export const runtime = "nodejs"; // NOT edge — tools need fs/child_process; key stays server-side
export const dynamic = "force-dynamic";

// GET /api/runs — the Recently list (past + present runs, newest first).
export async function GET() {
  return NextResponse.json({ runs: listRuns() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
  const roots = Array.isArray(body?.roots) ? body.roots.filter((r: unknown) => typeof r === "string") : undefined;
  // Pre-flight: fail calmly BEFORE starting if the chosen folder isn't usable.
  if (roots && roots.length) {
    const pre = checkRoots(roots);
    if (!pre.ok) return NextResponse.json({ error: pre.problem }, { status: 400 });
  }
  const runId = await startRun(message, roots);
  return NextResponse.json({ runId });
}
