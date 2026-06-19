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

rmSync(dbPath, { force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
