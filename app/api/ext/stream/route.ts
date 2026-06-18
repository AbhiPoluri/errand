// GET /api/ext/stream — the extension holds this open. Errand pushes commands down it
// (an active stream keeps the MV3 service worker alive); the extension POSTs results to
// /api/ext/result. One connection at a time (single user).
import { NextRequest } from "next/server";
import { registerStream, unregisterStream } from "../../../../src/server/extension.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = crypto.randomUUID();
  const enc = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Pass cleanup as the supersede callback so a reconnect stops THIS heartbeat immediately
      // instead of leaving it to fire once more (~10s) and clean up on the resulting enqueue throw.
      registerStream(controller, id, cleanup);
      controller.enqueue(enc.encode(": connected\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 10_000);
      req.signal.addEventListener("abort", cleanup, { once: true });
      function cleanup() {
        if (heartbeat) clearInterval(heartbeat);
        unregisterStream(id);
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unregisterStream(id);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
