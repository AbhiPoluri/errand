// Logger must honor its "never let logging break a run" contract: the JSONL trace records raw,
// unknown-typed payloads (SDK usage objects, errors), so a circular reference or BigInt must NOT throw
// out of log(). Locks the fix that moved JSON.stringify inside the try. Offline, temp dir.
// Run: `npm run log:test`.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Logger } from "./log.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const dir = mkdtempSync(join(tmpdir(), "errand-logtest-"));
const logger = new Logger("logtest", dir);
const file = join(dir, "run-logtest.jsonl");

logger.log("event", { a: 1, b: "two" }); // a normal, serializable payload

const circular: any = { name: "x" };
circular.self = circular; // circular reference → JSON.stringify throws
let threwCirc = false;
try {
  logger.log("circular", circular);
} catch {
  threwCirc = true;
}
check("a circular payload does not throw out of log()", !threwCirc);

let threwBig = false;
try {
  logger.log("bigint", { n: 10n }); // BigInt → JSON.stringify throws
} catch {
  threwBig = true;
}
check("a BigInt payload does not throw out of log()", !threwBig);

// Every line that was written must be valid JSON (the map throws if any isn't).
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("all 3 calls wrote a valid JSONL line", lines.length === 3, `${lines.length}`);
check("normal payload kept its data", lines.some((l) => l.kind === "event" && l.data?.a === 1));
check("circular payload recorded as [unserializable] (not lost, not crashed)", lines.some((l) => l.kind === "circular" && l.data === "[unserializable]"));
check("BigInt payload recorded as [unserializable]", lines.some((l) => l.kind === "bigint" && l.data === "[unserializable]"));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
