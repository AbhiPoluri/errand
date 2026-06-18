// Extension bridge test (r2 rank 2) — offline, pure in-memory (globalThis maps, no network).
// Verifies a disconnect/reconnect fails parked sendCommand promises IMMEDIATELY with an honest
// reason, instead of leaving them to wait out the 30s "took too long" timer.
import { registerStream, unregisterStream, sendCommand, isExtConnected } from "./server/extension.ts";

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
  registerStream(fakeController(() => (bClosed = true)), "B");
  const parkedB = sendCommand("read", {});
  registerStream(fakeController(), "C"); // supersede B
  const rB = await settledFast(parkedB);
  check("superseded connection's pending failed fast", rB.ok === false && /reconnect/.test(rB.error ?? ""), JSON.stringify(rB));
  check("old controller (B) was closed on supersede", bClosed);
  check("still connected (as the new stream C)", isExtConnected());
  unregisterStream("B"); // stale id — must be ignored
  check("stale unregister(B) ignored", isExtConnected());
  unregisterStream("C");
  check("unregister(C) disconnects", !isExtConnected());

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
