// GET /api/ext/status — is the Errand extension currently connected (polling)?
import { NextResponse } from "next/server";
import { isExtConnected } from "../../../../src/server/extension.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ connected: isExtConnected() }, { headers: { "Access-Control-Allow-Origin": "*" } });
}
