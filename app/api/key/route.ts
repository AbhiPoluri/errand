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
type ParentPort = {
  postMessage(m: unknown): void;
  on(ev: "message", cb: (e: { data: unknown }) => void): void;
  removeListener(ev: "message", cb: (e: { data: unknown }) => void): void;
};
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

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
  // Hand the key to the main process (it owns safeStorage). It encrypts, persists, replies with the
  // outcome, and on success restarts the core so the new key takes effect — the renderer never touches
  // the encrypted bytes. We AWAIT that reply so a real failure (e.g. no OS keychain → key not stored)
  // is surfaced honestly, instead of the old fire-and-forget "ok" that lied when the save silently
  // failed. A missing reply within the timeout means the success-path restart already tore down this
  // process — which only happens AFTER the key was stored — so we treat a timeout as success.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stored = await new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onMsg = (e: { data: unknown }) => {
      const m = e?.data as { type?: string; id?: string; ok?: boolean } | undefined;
      if (m && m.type === "errand:set-key:result" && m.id === id) {
        clearTimeout(timer);
        parentPort.removeListener("message", onMsg);
        resolve(!!m.ok);
      }
    };
    timer = setTimeout(() => {
      parentPort.removeListener("message", onMsg);
      resolve(true); // restart killed us before replying → the save had already succeeded
    }, 2500);
    parentPort.on("message", onMsg);
    parentPort.postMessage({ type: "errand:set-key", id, key });
  });
  if (!stored) {
    return NextResponse.json(
      { ok: false, error: "Couldn’t store the key securely on this system (no OS keychain available)." },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, restarting: true });
}
