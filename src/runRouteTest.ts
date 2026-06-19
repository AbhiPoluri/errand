// Locks the run-route contract: auto/cancel/decision return 404 (not 200 ok:false) for a missing run —
// matching /message + /undo — and /decision only accepts the user-submittable decisions (no injecting
// the internal "cancelled"/"expired" outcomes). Isolated ERRAND_DB, no live runs. Run: `npm run runroute:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dbPath = join(tmpdir(), `errand-runroutetest-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // MUST be set before runRegistry/store opens the DB
// Bracketed dir names are literal path segments — tsx resolves them fine.
const auto = (await import("../app/api/runs/[runId]/auto/route.ts")).POST;
const cancel = (await import("../app/api/runs/[runId]/cancel/route.ts")).POST;
const decision = (await import("../app/api/runs/[runId]/decision/route.ts")).POST;
const runsDelete = (await import("../app/api/runs/route.ts")).DELETE;
const memDelete = (await import("../app/api/memory/route.ts")).DELETE;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const params = { params: { runId: "does-not-exist" } };
const req = (body: unknown) => ({ json: async () => body }) as any; // routes only use req.json()
const status = async (p: Promise<Response>) => (await p).status;

// Missing run → 404 (was 200 {ok:false}), matching /message + /undo.
check("auto: missing run -> 404", (await status(auto(req({ enabled: true }), params))) === 404);
check("cancel: missing run -> 404", (await status(cancel(req({}), params))) === 404);
check("decision: valid decision on missing run -> 404", (await status(decision(req({ callId: "c1", decision: "approved" }), params))) === 404);

// decision allow-list: only user-submittable decisions; bad/internal values -> 400 (no run touched).
check("decision: unknown value -> 400", (await status(decision(req({ callId: "c1", decision: "bogus" }), params))) === 400);
check("decision: 'cancelled' rejected (allow-list narrowed) -> 400", (await status(decision(req({ callId: "c1", decision: "cancelled" }), params))) === 400);
check("decision: 'expired' rejected -> 400", (await status(decision(req({ callId: "c1", decision: "expired" }), params))) === 400);
check("decision: missing callId -> 400", (await status(decision(req({ decision: "approved" }), params))) === 400);

// --- DELETE-route hardening: bounds + de-dupe (runs), known-type requirement (memory) ---
check("runs DELETE: empty ids -> 400", (await status(runsDelete(req({ ids: [] })))) === 400);
check("runs DELETE: over-cap (>200) -> 400", (await status(runsDelete(req({ ids: Array.from({ length: 201 }, (_, i) => `r${i}`) })))) === 400);
const dedup = await runsDelete(req({ ids: ["a", "a", "b"] }));
check("runs DELETE: de-dupes the batch (deleted=2 for [a,a,b])", dedup.status === 200 && (await dedup.json()).deleted === 2);
check("memory DELETE: missing id -> 400", (await status(memDelete(req({ type: "memory" })))) === 400);
check("memory DELETE: unknown type -> 400 (was a silent wrong-store delete)", (await status(memDelete(req({ id: "m1", type: "bogus" })))) === 400);
check("memory DELETE: type omitted defaults to memory -> 200", (await status(memDelete(req({ id: "m1" })))) === 200);
check("memory DELETE: suggestion -> 200", (await status(memDelete(req({ id: "s1", type: "suggestion" })))) === 200);

rmSync(dbPath, { force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
