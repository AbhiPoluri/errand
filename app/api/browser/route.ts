// GET  /api/browser — is the user's Chrome attached?
// POST /api/browser — attach (launching the debug Chrome if needed). Returns connected.
import { NextRequest, NextResponse } from "next/server";
import { connect, isConnected, connectedBrowser, detectBrowsers, safariOnly } from "../../../src/server/browser.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    connected: isConnected(),
    connectedBrowser: connectedBrowser(),
    browsers: detectBrowsers(),
    safariOnly: safariOnly(),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const browser = typeof body?.browser === "string" ? body.browser : undefined;
  const result = await connect(browser);
  return NextResponse.json(result);
}
