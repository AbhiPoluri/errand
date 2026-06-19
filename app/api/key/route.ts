// GET  /api/key — is an OpenRouter key configured (and is this the desktop app, where it can be set)?
// POST /api/key { key } — store a new key. The renderer can't reach safeStorage (main-process only),
// so the route forwards the key to the Electron main process over the utility-process channel
// (process.parentPort), which encrypts + persists it and restarts the core. In the web app there is
// no parent port, so key entry isn't available there (use OPENROUTER_API_KEY in .env).
import { NextResponse } from "next/server";
import { hasApiKey } from "../../../src/config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// process.parentPort exists only when this server runs as an Electron utilityProcess (the desktop app).
const parentPort = (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort;

export function GET() {
  return NextResponse.json({ configured: hasApiKey(), desktop: !!parentPort });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { key?: unknown };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return NextResponse.json({ ok: false, error: "Enter your OpenRouter key." }, { status: 400 });
  }
  // Shape-check before we overwrite the stored key + restart: an OpenRouter key starts with "sk-or-".
  // (Stops a typo/garbage paste from replacing a working key with one that just 401s.)
  if (!/^sk-or-/.test(key) || key.length < 20) {
    return NextResponse.json({ ok: false, error: 'That doesn’t look like an OpenRouter key — they start with "sk-or-".' }, { status: 400 });
  }
  if (!parentPort) {
    return NextResponse.json(
      { ok: false, error: "Key entry is only available in the Errand desktop app. In the web app, set OPENROUTER_API_KEY in your .env." },
      { status: 400 },
    );
  }
  // Hand the key to the main process (it owns safeStorage). It encrypts, persists, and restarts the
  // core so the new key takes effect — the renderer never touches the encrypted bytes.
  parentPort.postMessage({ type: "errand:set-key", key });
  return NextResponse.json({ ok: true, restarting: true });
}
