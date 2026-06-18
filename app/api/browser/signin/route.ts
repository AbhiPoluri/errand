// POST /api/browser/signin — open the Errand browser profile as a NORMAL window so the
// user can sign into Google (automated browsers are blocked from Google login). The
// session persists in the profile for later automated use.
import { NextRequest, NextResponse } from "next/server";
import { openForSignIn } from "../../../../src/server/browser.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const browser = typeof body?.browser === "string" ? body.browser : undefined;
  const result = await openForSignIn(browser);
  return NextResponse.json(result);
}
