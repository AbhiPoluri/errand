// run_command output-cap test (r3 rank 2) — a big command output must NOT be retained past
// OUTPUT_CAP in RAM, and the reported `bytes` must reflect what was actually returned (not the
// uncapped accumulator). Sandboxed temp dir, no network.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "./journal.ts";
import type { ToolContext } from "./tools/index.ts";
import { bash } from "./tools/bash.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

async function main() {
  const root = mkdtempSync(join(tmpdir(), "errand-bash-"));
  writeFileSync(join(root, "big.txt"), "a".repeat(5_000_000)); // 5MB
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    journal: new Journal(),
    runId: "bash-test",
    workspaceRoot: root,
    roots: [root],
  };
  const res = await bash.run({ command: "cat big.txt" }, ctx);
  const d = res.data as any;
  check("command ran ok", res.ok, JSON.stringify(res.error));
  check("stdout capped at OUTPUT_CAP (<= 16000)", typeof d?.stdout === "string" && d.stdout.length <= 16_000, `${d?.stdout?.length}`);
  check("reported bytes reflect the capped output (<= 2*OUTPUT_CAP)", (res.bytes ?? 0) <= 32_000, `${res.bytes}`);
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
