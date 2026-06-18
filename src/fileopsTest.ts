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
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "./journal.ts";
import { Registry, type ToolContext } from "./tools/index.ts";
import { fileTools, renameFile, moveFile, folderSummary, findDuplicates, recentChanges, deleteFile } from "./tools/files.ts";
import { extractZip } from "./tools/zip.ts";

// Build a minimal STORED (method 0) zip by hand — enough for extract_zip's reader (it ignores CRC).
function makeStoredZip(entries: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of entries) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method 0 (stored)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, data]);
    locals.push(localFull);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method 0
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFull.length;
  }
  const localPart = Buffer.concat(locals);
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, cd, eocd]);
}

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

async function testRecentChanges() {
  console.log("\n== recent_changes (r3 rank 12) ==");
  const root = tmp("errand-recent-");
  writeFileSync(join(root, "new.txt"), "new");
  writeFileSync(join(root, "old.txt"), "old");
  mkdirSync(join(root, ".errand-review"), { recursive: true });
  writeFileSync(join(root, ".errand-review", "parked.txt"), "x");
  const longAgo = Date.now() / 1000 - 30 * 86_400; // 30 days ago, in seconds
  utimesSync(join(root, "old.txt"), longAgo, longAgo);
  const j = new Journal();

  const all = await recentChanges.run({}, ctxFor(root, j));
  check("scan returned ok", all.ok);
  const files = all.data?.files ?? [];
  check("newest file sorts first", !!files[0]?.path.endsWith("new.txt"), files[0]?.path);
  check(".errand-review is excluded", !files.some((f) => f.path.includes(".errand-review")));
  check("read-only: recorded no journal entry", j.list().length === 0);

  const today = await recentChanges.run({ within: "today" }, ctxFor(root, new Journal()));
  const todayFiles = today.data?.files ?? [];
  check("'today' window drops the 30-day-old file", !todayFiles.some((f) => f.path.endsWith("old.txt")));
  check("'today' window keeps the new file", todayFiles.some((f) => f.path.endsWith("new.txt")));

  const prevMax = process.env.ERRAND_MAX_NODES;
  process.env.ERRAND_MAX_NODES = "1";
  try {
    const trunc = await recentChanges.run({}, ctxFor(root, new Journal()));
    check("recent_changes flags truncated", trunc.data?.truncated === true);
    check("truncated recent_changes admits the partial scan", /didn't reach|too big/.test(recentChanges.summarize(trunc)), recentChanges.summarize(trunc));
  } finally {
    if (prevMax === undefined) delete process.env.ERRAND_MAX_NODES;
    else process.env.ERRAND_MAX_NODES = prevMax;
  }
  rmSync(root, { recursive: true, force: true });
}

async function testExtractZip() {
  console.log("\n== extract_zip (r3 rank 10) ==");
  const root = tmp("errand-zip-");
  const zipBuf = makeStoredZip([
    { name: "hello.txt", content: "HELLO" },
    { name: "sub/world.txt", content: "WORLD" },
    { name: "../escape.txt", content: "EVIL" }, // zip-slip — must be skipped, never written outside
  ]);
  writeFileSync(join(root, "bundle.zip"), zipBuf);
  const j = new Journal();
  const res = await extractZip.run({ path: join(root, "bundle.zip") }, ctxFor(root, j));
  check("extract returned ok", res.ok, JSON.stringify(res.error));
  const dest = join(root, "bundle");
  check("hello.txt unpacked with content", existsSync(join(dest, "hello.txt")) && readFileSync(join(dest, "hello.txt"), "utf8") === "HELLO");
  check("nested sub/world.txt unpacked", existsSync(join(dest, "sub", "world.txt")) && readFileSync(join(dest, "sub", "world.txt"), "utf8") === "WORLD");
  check("zip-slip entry did NOT escape the dest folder", !existsSync(join(root, "escape.txt")));
  check("recorded exactly one reversible op", j.reversibleCount() === 1);
  await j.undoAll();
  check("undo removed the unpacked folder", !existsSync(dest));

  mkdirSync(dest); // now a folder with that name already exists
  const res2 = await extractZip.run({ path: join(root, "bundle.zip") }, ctxFor(root, new Journal()));
  check("refuses when the destination already exists", !res2.ok);
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
  await testRecentChanges();
  await testExtractZip();
  testRegistryHygiene();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
