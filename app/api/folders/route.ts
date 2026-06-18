// GET /api/folders — the folders Errand may be pointed at (only ones that exist).
import { NextResponse } from "next/server";
import { availableFolders } from "../../../src/server/folders.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ folders: availableFolders() });
}
