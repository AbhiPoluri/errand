// GET /api/memory — what Errand remembers + pending proactive suggestions.
// DELETE /api/memory — remove one, body: { id, type: "memory" | "suggestion" }.
import { NextRequest, NextResponse } from "next/server";
import { listMemories, deleteMemory, listSuggestions, deleteSuggestion } from "../../../src/server/store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ memories: listMemories(), suggestions: listSuggestions() });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (typeof body?.id !== "string") return NextResponse.json({ error: "id required" }, { status: 400 });
  // Require an explicit, known type (default "memory" for back-compat when omitted). Without this, a
  // typo'd type silently fell through to deleteMemory — deleting from the wrong store.
  const type = body.type === undefined ? "memory" : body.type;
  if (type !== "memory" && type !== "suggestion") {
    return NextResponse.json({ error: 'type must be "memory" or "suggestion"' }, { status: 400 });
  }
  if (type === "suggestion") deleteSuggestion(body.id);
  else deleteMemory(body.id);
  return NextResponse.json({ ok: true });
}
