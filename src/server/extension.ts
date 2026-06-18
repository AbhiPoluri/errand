// Bridge to the Errand Chrome extension. The extension holds ONE long-lived streaming
// connection (keeps the MV3 service worker alive + instant command push); Errand writes
// commands into that stream and the extension POSTs results back. This replaced a poll
// loop, which died whenever Chrome suspended the idle service worker.
export interface ExtCommand {
  id: string;
  type: "navigate" | "read" | "click" | "type" | "screenshot" | "scroll";
  args: any;
}

interface Pending {
  resolve: (r: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Controller = ReadableStreamDefaultController<Uint8Array>;

const g = globalThis as unknown as {
  __extStream?: { controller?: Controller; id?: string };
  __extPending?: Map<string, Pending>;
};
const stream = (g.__extStream ??= {});
const pending: Map<string, Pending> = (g.__extPending ??= new Map());
const enc = new TextEncoder();

export function isExtConnected(): boolean {
  return !!stream.controller;
}

// Fail every in-flight command now (clearing its timer) with an honest reason, instead of letting
// each wait out its 30s "took too long" timer when the real cause is a disconnect/reconnect.
function failAllPending(error: string): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error });
  }
  pending.clear();
}

// Called by the SSE route when the extension connects / disconnects.
export function registerStream(controller: Controller, id: string): void {
  // A fresh connection supersedes any prior one: fail its in-flight commands and close the old
  // controller so they don't hang waiting on a stream that's about to be replaced.
  if (stream.controller && stream.id !== id) {
    failAllPending("the browser reconnected");
    try {
      stream.controller.close();
    } catch {
      /* already closed */
    }
  }
  stream.controller = controller;
  stream.id = id;
}
export function unregisterStream(id: string): void {
  if (stream.id === id) {
    stream.controller = undefined;
    stream.id = undefined;
    // Resolve parked commands immediately with the true reason rather than the misleading
    // "took too long" 30s later (tab close, Chrome suspend, laptop sleep are routine).
    failAllPending("the browser disconnected");
  }
}

// Push a command down the stream and wait for the extension to report its result.
export function sendCommand(type: ExtCommand["type"], args: any = {}, timeoutMs = 30_000): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    if (!stream.controller) return resolve({ ok: false, error: "the browser isn't connected" });
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "the browser took too long to respond" });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    try {
      stream.controller.enqueue(enc.encode(`data: ${JSON.stringify({ id, type, args })}\n\n`));
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: "the browser isn't connected" });
    }
  });
}

export function resolveResult(id: string, result: any): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(result);
  return true;
}
