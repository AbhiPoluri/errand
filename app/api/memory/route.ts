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
  if (body.type === "suggestion") deleteSuggestion(body.id);
  else deleteMemory(body.id);
  return NextResponse.json({ ok: true });
}
