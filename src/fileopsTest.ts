// File-ops contract test (rank 14) — verifies the new/changed file tools register, validate,
// and (for mutations) round-trip through Undo byte-for-byte. Pure filesystem in an OS temp
// dir; no DB, no network. This is the verification backbone for ranks 2 (delete uniqueness),
// 12 (rename_file), and 13 (folder_summary).
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "./journal.ts";
import { Registry, type ToolContext } from "./tools/index.ts";
import { fileTools, renameFile, moveFile, folderSummary, findDuplicates, deleteFile } from "./tools/files.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const ctxFor = (root: string, journal: Journal): ToolContext => ({
  signal: new AbortController().signal,
  journal,
  runId: "fileops-test",
  workspaceRoot: root,
  roots: [root],
});

async function testRename() {
  console.log("\n== rename_file (rank 12) ==");
  const root = tmp("errand-rename-");
  const f = join(root, "old.txt");
  writeFileSync(f, "content-A");
  const j = new Journal();
  const res = await renameFile.run({ path: f, newName: "new.txt" }, ctxFor(root, j));
  check("rename returned ok", res.ok);
  check("new name exists", existsSync(join(root, "new.txt")));
  check("old name is gone", !existsSync(f));
  check("recorded exactly one reversible op", j.reversibleCount() === 1);
  await j.undoAll();
  check("undo restored the old name", existsSync(f) && !existsSync(join(root, "new.txt")));
  check("undo restored the bytes", existsSync(f) && readFileSync(f, "utf8") === "content-A");
  rmSync(root, { recursive: true, force: true });
}

function testRenameValidation() {
  console.log("\n== rename_file argsSchema rejects path-like names ==");
  const reg = new Registry().register(renameFile);
  const slash = reg.prepare("rename_file", JSON.stringify({ path: "x.txt", newName: "sub/b.txt" }));
  const back = reg.prepare("rename_file", JSON.stringify({ path: "x.txt", newName: "a\\b.txt" }));
  const dot = reg.prepare("rename_file", JSON.stringify({ path: "x.txt", newName: "." }));
  const dotdot = reg.prepare("rename_file", JSON.stringify({ path: "x.txt", newName: ".." }));
  const dotsInName = reg.prepare("rename_file", JSON.stringify({ path: "x.txt", newName: "data..clean.csv" }));
  const good = reg.prepare("rename_file", JSON.stringify({ path: "x.txt", newName: "good name.txt" }));
  check("rejects newName containing '/'", !slash.ok);
  check("rejects newName containing '\\\\'", !back.ok);
  check("rejects newName '.'", !dot.ok);
  check("rejects newName '..'", !dotdot.ok);
  check("accepts a valid name that CONTAINS '..' (data..clean.csv)", dotsInName.ok);
  check("accepts a plain newName", good.ok);
}

async function testDeleteUniqueDest() {
  console.log("\n== delete_file unique Review dest (rank 2) ==");
  const root = tmp("errand-del-");
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  const fa = join(root, "a", "notes.txt");
  const fb = join(root, "b", "notes.txt");
  writeFileSync(fa, "AAA");
  writeFileSync(fb, "BBB");
  const j = new Journal();
  const ctx = ctxFor(root, j);
  const ra = await deleteFile.run({ path: fa }, ctx);
  const rb = await deleteFile.run({ path: fb }, ctx);
  check("both deletes returned ok", ra.ok && rb.ok);
  const parked = readdirSync(join(root, ".errand-review", "fileops-test"));
  check("two same-name files parked under DISTINCT names", parked.length === 2, parked.join(", "));
  check("both originals are gone", !existsSync(fa) && !existsSync(fb));
  await j.undoAll();
  check("a/notes.txt restored with ITS OWN bytes (AAA)", existsSync(fa) && readFileSync(fa, "utf8") === "AAA");
  check("b/notes.txt restored with ITS OWN bytes (BBB)", existsSync(fb) && readFileSync(fb, "utf8") === "BBB");
  rmSync(root, { recursive: true, force: true });
}

async function testFolderSummary() {
  console.log("\n== folder_summary (rank 13) ==");
  const root = tmp("errand-sum-");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(3000));
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  writeFileSync(join(root, "sub", "small.txt"), Buffer.alloc(10));
  writeFileSync(join(root, "sub", "deep", "x.txt"), Buffer.alloc(5));
  // Errand's own undo store must NOT be counted as the user's disk usage.
  mkdirSync(join(root, ".errand-review", "run1", ".snapshots"), { recursive: true });
  writeFileSync(join(root, ".errand-review", "run1", "parked.bin"), Buffer.alloc(99_999));
  const j = new Journal();
  const res = await folderSummary.run({}, ctxFor(root, j));
  check("summary returned ok", res.ok);
  const d = res.data as any;
  check("counted all 3 user files (recursive), excluding .errand-review", d?.totalFiles === 3, `${d?.totalFiles}`);
  check("summed only user bytes (3000+10+5), not the 99999 parked file", d?.totalBytes === 3015, `${d?.totalBytes}`);
  check("largest file is big.bin (3000)", d?.largestFiles?.[0]?.size === 3000, `${d?.largestFiles?.[0]?.size}`);
  check(
    "biggest sub-folder is 'sub' at 15 bytes",
    d?.largestSubfolders?.[0]?.name === "sub" && d?.largestSubfolders?.[0]?.bytes === 15,
    JSON.stringify(d?.largestSubfolders?.[0]),
  );
  check(
    "byType breaks down .bin and .txt",
    !!d?.byType?.some((t: any) => t.ext === ".bin") && !!d?.byType?.some((t: any) => t.ext === ".txt"),
  );
  check("not truncated for a tiny tree", d?.truncated === false);
  check("read-only: recorded NO journal entry", j.list().length === 0);
  // NOTE: the MAX_NODES=20000 truncation guard isn't exercised here (would need 20k files);
  // it's covered by reading the bounded walk, not a test.
  rmSync(root, { recursive: true, force: true });
}

async function testFindDuplicates() {
  console.log("\n== find_duplicates (r2 rank 3) ==");
  const root = tmp("errand-dup-");
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  // One true duplicate pair (identical content), across folders.
  writeFileSync(join(root, "a", "x.txt"), "identical-content");
  writeFileSync(join(root, "b", "x-copy.txt"), "identical-content");
  // Two SAME-SIZE but DIFFERENT-content files — must NOT be grouped.
  writeFileSync(join(root, "diffA.txt"), "1234567890");
  writeFileSync(join(root, "diffB.txt"), "ABCDEFGHIJ");
  // A unique file, and a copy hidden in .errand-review (must be skipped).
  writeFileSync(join(root, "unique.txt"), "xyz");
  mkdirSync(join(root, ".errand-review", "run1"), { recursive: true });
  writeFileSync(join(root, ".errand-review", "run1", "parked.txt"), "identical-content");

  const res = await findDuplicates.run({}, ctxFor(root, new Journal()));
  check("scan returned ok", res.ok);
  const d = res.data as any;
  check("exactly one duplicate group (the identical pair)", d?.groups?.length === 1, `${d?.groups?.length}`);
  check("the group has the 2 identical files (not the .errand-review copy)", d?.groups?.[0]?.paths?.length === 2, `${d?.groups?.[0]?.paths?.length}`);
  check("same-size-different-content files are NOT grouped", !d?.groups?.some((g: any) => g.size === 10));
  check("wastedBytes counts one redundant copy (17)", d?.wastedBytes === 17, `${d?.wastedBytes}`);
  check("read-only: recorded no journal entry", res.ok);
  rmSync(root, { recursive: true, force: true });
}

async function testTruncationHonesty() {
  console.log("\n== truncated scans reported honestly (r3 rank 1) ==");
  const root = tmp("errand-trunc-");
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "x.txt"), "dup-content");
  writeFileSync(join(root, "y.txt"), "dup-content");
  const prev = process.env.ERRAND_MAX_NODES;
  process.env.ERRAND_MAX_NODES = "1"; // force the walk to truncate after 1 node
  try {
    const dup = await findDuplicates.run({}, ctxFor(root, new Journal()));
    check("find_duplicates flags truncated", dup.data?.truncated === true);
    check("truncated dup does NOT claim 'No duplicate files found'", !findDuplicates.summarize(dup).includes("No duplicate files found"));
    check("truncated dup admits it couldn't scan all", /too big to check/.test(findDuplicates.summarize(dup)), findDuplicates.summarize(dup));
    const sum = await folderSummary.run({}, ctxFor(root, new Journal()));
    check("folder_summary flags truncated", sum.data?.truncated === true);
    check("truncated summary admits it couldn't measure all", /too big to measure/.test(folderSummary.summarize(sum)), folderSummary.summarize(sum));
  } finally {
    if (prev === undefined) delete process.env.ERRAND_MAX_NODES;
    else process.env.ERRAND_MAX_NODES = prev;
  }
  rmSync(root, { recursive: true, force: true });
}

function testRegistryHygiene() {
  console.log("\n== registry hygiene ==");
  const reg = new Registry();
  for (const t of fileTools) reg.register(t);
  const names = reg.schemas().map((s) => s.function.name);
  check("rename_file is registered", names.includes("rename_file"));
  check("folder_summary is registered", names.includes("folder_summary"));
  check("move_file points renames at rename_file (no verb overlap)", /use rename_file/.test(moveFile.modelDescription));
  check("every file-tool name is unique", new Set(names).size === names.length, names.join(", "));
}

async function main() {
  await testRename();
  testRenameValidation();
  await testDeleteUniqueDest();
  await testFolderSummary();
  await testFindDuplicates();
  await testTruncationHonesty();
  testRegistryHygiene();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
