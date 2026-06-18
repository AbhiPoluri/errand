// POST /api/runs — start a new run. Returns { runId }. The run executes server-side
// (real fs + child_process); the browser watches it via the SSE stream.
import { NextRequest, NextResponse } from "next/server";
import { startRun, listRuns, removeRun } from "../../../src/server/runRegistry.ts";
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
  // Starting an errand is the first thing every user does, and startRun does real work
  // (memory retrieval -> embeddings, DB writes). Any throw here would otherwise return Next's
  // default unstyled 500 HTML, which the JSON-expecting client renders as nothing. Return calm
  // JSON instead — useRun.start already reads `error` off a non-ok response.
  try {
    const runId = await startRun(message, roots);
    return NextResponse.json({ runId });
  } catch (e) {
    console.error("[api/runs] startRun failed:", e);
    return NextResponse.json({ error: "I couldn't start that just now. Want to try again?" }, { status: 500 });
  }
}

// DELETE /api/runs — remove one or more conversations. Body: { ids: string[] }.
export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : [];
  if (!ids.length) return NextResponse.json({ error: "no ids" }, { status: 400 });
  for (const id of ids) removeRun(id);
  return NextResponse.json({ ok: true, deleted: ids.length });
}
