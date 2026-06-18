// GET /api/runs/:runId/stream — Server-Sent Events. Replays buffered events (honoring
// Last-Event-ID on reconnect), streams new ones, heartbeats every ~10s through long
// reasoning gaps. Stays open across turns; the browser closes it when leaving.
import { NextRequest } from "next/server";
import { getRun } from "../../../../../src/server/runRegistry.ts";
import type { AgentEvent } from "../../../../../src/events.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  const entry = getRun(params.runId);
  if (!entry) return new Response("run not found", { status: 404 });

  const lastId = req.headers.get("last-event-id");
  const fromSeq = lastId ? Number(lastId) + 1 : 0;
  const enc = new TextEncoder();

  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: AgentEvent) => {
        try {
          controller.enqueue(enc.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      };
      unsubscribe = entry.sink.subscribe(send, Number.isFinite(fromSeq) ? fromSeq : 0);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 10_000);
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
