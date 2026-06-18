// Extension bridge test (r2 rank 2) — offline, pure in-memory (globalThis maps, no network).
// Verifies a disconnect/reconnect fails parked sendCommand promises IMMEDIATELY with an honest
// reason, instead of leaving them to wait out the 30s "took too long" timer.
import { registerStream, unregisterStream, sendCommand, isExtConnected, resolveResult } from "./server/extension.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const fakeController = (onClose?: () => void): any => ({ enqueue() {}, close: () => onClose?.() });
// Race a parked command against a short timer; if it hasn't resolved fast, the fix didn't fire.
const settledFast = (p: Promise<any>) =>
  Promise.race([p, new Promise((res) => setTimeout(() => res({ ok: true, error: "DID_NOT_SETTLE" }), 1000))]);

async function main() {
  console.log("\n== disconnect fails parked commands immediately ==");
  registerStream(fakeController(), "A");
  check("connected after register", isExtConnected());
  const parked = sendCommand("read", {}); // extension never reports a result
  unregisterStream("A"); // SSE drop
  const r = await settledFast(parked);
  check("parked command settled FAST (not after 30s)", r.ok === false && /disconnect/.test(r.error ?? ""), JSON.stringify(r));
  check("not connected after disconnect", !isExtConnected());

  console.log("\n== a fresh connection supersedes the old + fails its pendings ==");
  let bClosed = false;
  let bCleanup = false;
  registerStream(fakeController(() => (bClosed = true)), "B", () => (bCleanup = true));
  const parkedB = sendCommand("read", {});
  registerStream(fakeController(), "C"); // supersede B
  const rB = await settledFast(parkedB);
  check("superseded connection's pending failed fast", rB.ok === false && /reconnect/.test(rB.error ?? ""), JSON.stringify(rB));
  check("old controller (B) was closed on supersede", bClosed);
  check("old route cleanup (onClose) ran on supersede (heartbeat stops now, not in 10s)", bCleanup);
  check("still connected (as the new stream C)", isExtConnected());
  unregisterStream("B"); // stale id — must be ignored
  check("stale unregister(B) ignored", isExtConnected());
  unregisterStream("C");
  check("unregister(C) disconnects", !isExtConnected());

  console.log("\n== a malformed extension result is normalized to the {ok:false} envelope ==");
  // Capture the command id off the SSE the controller receives, so we can resolve it directly.
  let lastCmdId = "";
  const capturing: any = {
    enqueue(bytes: Uint8Array) {
      const m = new TextDecoder().decode(bytes).match(/"id":"([^"]+)"/);
      if (m) lastCmdId = m[1];
    },
    close() {},
  };
  registerStream(capturing, "F");
  const parkedF = sendCommand("read", {});
  resolveResult(lastCmdId, "a-bare-string"); // malformed (not an object)
  const rr = await settledFast(parkedF);
  check("malformed (non-object) result normalized to {ok:false}", rr && typeof rr === "object" && rr.ok === false, JSON.stringify(rr));
  unregisterStream("F");

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
