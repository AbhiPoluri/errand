// Verifies the safe-folder fix: Errand's own sandbox (config.workspaceRoot) must auto-create, so a
// fresh install never fails a default-scoped run with "couldn't open that folder". Regression test
// for the packaged-app bug where the workspace under userData was never made. Isolated via
// ERRAND_DATA (a fresh temp dir → a workspace that does NOT exist yet). Run: `npm run folders:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync, mkdtempSync } from "node:fs";

const dataDir = mkdtempSync(join(tmpdir(), "errand-folderstest-"));
process.env.ERRAND_DATA = dataDir; // workspaceRoot -> dataDir/workspace, which does not exist yet
const folders = await import("./server/folders.ts");
const { config } = await import("./config.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

async function main(): Promise<void> {
  const ws = config.workspaceRoot;
  check("safe folder resolves under ERRAND_DATA", ws === join(dataDir, "workspace"), ws);
  check("safe folder does NOT exist before any folder op", !existsSync(ws));

  // THE FIX: checkRoots on the (non-existent) safe folder used to fail dirUsable -> the snag the
  // user hit. It must now succeed, having auto-created the sandbox.
  const r = folders.checkRoots([ws]);
  check("checkRoots([safe folder]) is ok even though it didn't exist", r.ok === true, JSON.stringify(r));
  check("...and the safe folder now exists on disk", existsSync(ws));

  // availableFolders re-creates it (so the picker always offers a real, usable folder).
  rmSync(ws, { recursive: true, force: true });
  const list = folders.availableFolders();
  check("availableFolders() re-created the safe folder", existsSync(ws));
  check("the safe folder is offered in the list", list.some((f) => f.key === "workspace" && f.safe));

  // ensureSafeFolder() directly + idempotent.
  rmSync(ws, { recursive: true, force: true });
  folders.ensureSafeFolder();
  check("ensureSafeFolder() creates it", existsSync(ws));
  folders.ensureSafeFolder(); // second call must not throw
  check("ensureSafeFolder() is idempotent (no throw on an existing dir)", existsSync(ws));

  // A folder NOT on the allow-list is still rejected (the fix didn't loosen the sandbox guard).
  const bad = folders.checkRoots(["/etc"]);
  check("a non-allowed folder is still rejected", bad.ok === false);

  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
