// v3 tests — the headline guarantee: a multi-step errand on REAL files, fully undone,
// leaves the folder byte-for-byte as it started. Plus the path-traversal guard, and a
// model-driven smoke run that exercises the tools through the loop.
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { config } from "./config.ts";
import { Session } from "./session.ts";
import { Logger } from "./log.ts";
import { Journal } from "./journal.ts";
import { Registry, type ToolContext } from "./tools/index.ts";
import { listFiles, fileTools, writeFile, moveFile, deleteFile } from "./tools/files.ts";
import { resolveWithin, PathError } from "./tools/fileutil.ts";
import { AgentRunner } from "./loop.ts";
import { ScriptedApprovalGate } from "./approvals.ts";
import type { AgentEvent, EventSink } from "./events.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

// Snapshot of files (relpath -> content), ignoring empty dirs and the Review folder.
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === ".errand-review") continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}
const eq = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

async function testReversibility() {
  console.log("\n== A. multi-step errand fully undone == ");
  const root = join(config.workspaceRoot, "__v3test");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "keep.txt"), "A");
  writeFileSync(join(root, "old.txt"), "B");
  writeFileSync(join(root, "data.csv"), "x,y");
  const before = snapshot(root);

  const journal = new Journal();
  const ctx: ToolContext = { signal: new AbortController().signal, journal, runId: "v3", workspaceRoot: config.workspaceRoot, roots: [root] };

  await writeFile.run({ path: join(root, "note.txt"), content: "hello" }, ctx);
  await writeFile.run({ path: join(root, "keep.txt"), content: "OVERWRITTEN" }, ctx);
  await moveFile.run({ from: join(root, "old.txt"), to: join(root, "archive", "old.txt") }, ctx);
  await deleteFile.run({ path: join(root, "data.csv") }, ctx);

  const after = snapshot(root);
  check("errand changed the folder", !eq(before, after));
  check("4 reversible ops journaled", journal.reversibleCount() === 4, `count=${journal.reversibleCount()}`);

  const res = await journal.undoAll();
  check("undoAll reported 4 undone", res.undone === 4 && res.failed === 0, JSON.stringify(res));
  const restored = snapshot(root);
  check("folder restored byte-for-byte", eq(before, restored), JSON.stringify({ before, restored }).slice(0, 200));
  rmSync(root, { recursive: true, force: true });
}

function testTraversalGuard() {
  console.log("\n== B. path-traversal + symlink guard ==");
  const root = join(config.workspaceRoot, "__v3guard");
  mkdirSync(root, { recursive: true });
  let blocked = false;
  try {
    resolveWithin([root], "../../../etc/passwd");
  } catch (e) {
    blocked = e instanceof PathError;
  }
  check("../ escape is rejected", blocked);
  const inside = resolveWithin([root], "sub/ok.txt");
  check("in-scope path resolves", inside.startsWith(root));
  rmSync(root, { recursive: true, force: true });
}

class Tap implements EventSink {
  events: AgentEvent[] = [];
  emit(e: AgentEvent) {
    this.events.push(e);
  }
}

async function testModelDriven() {
  console.log("\n== C. model-driven errand through the loop ==");
  const root = join(config.workspaceRoot, "__v3model");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "report.txt"), "hi");
  writeFileSync(join(root, "notes.txt"), "stuff");

  const runId = crypto.randomUUID();
  const session = new Session("You are Errand, a calm helper. Keep replies short and plain. Never use emojis. Use tools to inspect files.");
  const tap = new Tap();
  const registry = new Registry();
  for (const t of fileTools) registry.register(t);
  const runner = new AgentRunner({
    session,
    sink: tap,
    registry,
    model: config.model,
    logger: new Logger(runId),
    runId,
    roots: [root],
    gate: new ScriptedApprovalGate([], "approved"),
  });

  const reply = await runner.send("How many files are in my folder, and what are they called?", new AbortController().signal);
  const usedList = tap.events.some((e) => e.type === "tool.proposed" && e.action.toLowerCase().includes("looking"));
  const transportErr = tap.events.some((e) => e.type === "run.error" && e.kind === "transport");
  check("model used list_files", usedList);
  check("run finished with a reply, no transport error", reply.length > 0 && !transportErr, `reply="${reply.slice(0, 80)}"`);
  rmSync(root, { recursive: true, force: true });
}

async function main() {
  await testReversibility();
  testTraversalGuard();
  await testModelDriven();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
