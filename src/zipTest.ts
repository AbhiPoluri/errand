// ZIP writer verification — the safety net the handoff demanded before shipping a from-scratch
// binary writer. Three layers: (1) buildZip output round-trips byte-for-byte through THIS repo's own
// reader (listZipEntries + inflateZipEntry); (2) the archive is validated by the SYSTEM `unzip -t`
// (an independent implementation — checks CRC-32s + structure), so we aren't just agreeing with
// ourselves; (3) the create_zip TOOL is exercised end-to-end in a temp sandbox incl. scope, caps,
// non-clobber, dedup, and Undo. Pure fs + a subprocess; no DB, no network. Run: `npm run zip:test`.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { buildZip, listZipEntries, inflateZipEntry, crc32, type ZipInput } from "./tools/extract.ts";
import { createZip } from "./tools/zip.ts";
import { Journal } from "./journal.ts";
import { Registry, type ToolContext } from "./tools/index.ts";

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const ctxFor = (root: string, journal: Journal): ToolContext => ({
  signal: new AbortController().signal,
  journal,
  runId: "zip-test",
  workspaceRoot: root,
  roots: [root],
});

// ---- layer 1: buildZip → our own reader, byte-for-byte ----
function testRoundTrip() {
  console.log("\n== buildZip round-trips through the reader ==");
  const inputs: ZipInput[] = [
    { name: "hello.txt", data: Buffer.from("hello world", "utf8") },
    { name: "compressible.txt", data: Buffer.from("A".repeat(10_000), "utf8") }, // deflate should win
    { name: "binary.bin", data: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) }, // every byte value
    { name: "empty.txt", data: Buffer.alloc(0) }, // zero-length edge
    { name: "café ☕.txt", data: Buffer.from("unicode name", "utf8") }, // UTF-8 filename flag
    { name: "nested/path/deep.txt", data: Buffer.from("kept its slashes", "utf8") },
  ];
  const zip = buildZip(inputs);
  const entries = listZipEntries(zip);
  check("entry count matches", entries.length === inputs.length, `${entries.length} vs ${inputs.length}`);
  check("names match in order", entries.map((e) => e.name).join("|") === inputs.map((i) => i.name).join("|"));
  for (const input of inputs) {
    const e = entries.find((x) => x.name === input.name);
    const got = e ? inflateZipEntry(zip, e) : null;
    check(`"${input.name}" bytes round-trip`, !!got && got.equals(input.data), got ? `${got.length}B` : "null");
  }
  const comp = entries.find((e) => e.name === "compressible.txt");
  check("compressible entry used DEFLATE (method 8)", comp?.method === 8);
  const bin = entries.find((e) => e.name === "binary.bin");
  check("incompressible entry stored or deflated, but smaller-or-equal kept", !!bin && bin.compSize <= 256 + 16);
  // CRC sanity: our crc32 of a known input matches the well-known value for "123456789".
  check("crc32('123456789') === 0xCBF43926", crc32(Buffer.from("123456789")) === 0xcbf43926);
}

// ---- layer 2: independent validation by the system `unzip` ----
function testSystemUnzip() {
  console.log("\n== system `unzip -t` accepts the archive (independent CRC/structure check) ==");
  let unzip = "";
  try {
    unzip = execFileSync("which", ["unzip"]).toString().trim();
  } catch {
    console.log("SKIP  `unzip` not on PATH — relying on the reader round-trip + extraction check");
    return;
  }
  const root = tmp("errand-zip-sys-");
  const zip = buildZip([
    { name: "a.txt", data: Buffer.from("alpha", "utf8") },
    { name: "b/c.txt", data: Buffer.from("B".repeat(5000), "utf8") },
    { name: "empty", data: Buffer.alloc(0) },
  ]);
  const zipPath = join(root, "out.zip");
  writeFileSync(zipPath, zip);
  try {
    execFileSync(unzip, ["-t", zipPath]); // non-zero exit throws → CRC or structure failure
    check("`unzip -t` reported no errors", true);
    // And extract for real, comparing bytes.
    execFileSync(unzip, ["-o", "-q", zipPath, "-d", join(root, "out")]);
    check("extracted a.txt matches", readFileSync(join(root, "out", "a.txt"), "utf8") === "alpha");
    check("extracted b/c.txt matches", readFileSync(join(root, "out", "b", "c.txt"), "utf8") === "B".repeat(5000));
  } catch (e) {
    check("`unzip -t` reported no errors", false, String((e as any)?.message ?? e));
  }
  rmSync(root, { recursive: true, force: true });
}

// ---- layer 3: the create_zip tool, end-to-end in a sandbox ----
async function testTool() {
  console.log("\n== create_zip tool: scope, caps, non-clobber, dedup, Undo ==");
  const root = tmp("errand-zip-tool-");
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  writeFileSync(join(root, "a", "notes.txt"), "AAA");
  writeFileSync(join(root, "b", "notes.txt"), "BBB"); // same basename → must be de-duplicated
  writeFileSync(join(root, "readme.md"), "# hi");

  const j = new Journal();
  const res = await createZip.run(
    { files: [join(root, "a", "notes.txt"), join(root, "b", "notes.txt"), join(root, "readme.md")], output: join(root, "bundle") },
    ctxFor(root, j),
  );
  check("tool returned ok", res.ok, res.ok ? "" : (res as any).summary);
  const outPath = join(root, "bundle.zip");
  check(".zip suffix was added", res.ok && res.data?.output === outPath);
  check("zip file exists on disk", existsSync(outPath));
  check("recorded exactly one reversible op", j.reversibleCount() === 1);

  // Read the produced archive back and confirm contents + dedup naming.
  const buf = readFileSync(outPath);
  const names = listZipEntries(buf).map((e) => e.name).sort();
  check("3 entries with de-duplicated names", names.join("|") === ["notes (2).txt", "notes.txt", "readme.md"].sort().join("|"), names.join("|"));
  const entries = listZipEntries(buf);
  const byName = (n: string) => inflateZipEntry(buf, entries.find((e) => e.name === n)!);
  check("first notes.txt content preserved", byName("notes.txt")?.toString() === "AAA");
  check("second (deduped) notes content preserved", byName("notes (2).txt")?.toString() === "BBB");

  // Non-clobber: a second create_zip to the same output must refuse, untouched.
  const before = readFileSync(outPath);
  const res2 = await createZip.run({ files: [join(root, "readme.md")], output: join(root, "bundle.zip") }, ctxFor(root, new Journal()));
  check("non-clobber: refuses an existing output", !res2.ok);
  check("non-clobber: left the original zip untouched", readFileSync(outPath).equals(before));

  // A folder as a source is refused (give the files inside).
  const res3 = await createZip.run({ files: [join(root, "a")], output: join(root, "folder") }, ctxFor(root, new Journal()));
  check("refuses a folder as a source file", !res3.ok);

  // Escape attempt: a path outside the root is rejected by scope.
  const res4 = await createZip.run({ files: ["../../etc/hosts"], output: join(root, "escape") }, ctxFor(root, new Journal()));
  check("refuses a source outside the sandbox", !res4.ok);

  // Undo removes the created zip.
  await j.undoAll();
  check("undo deleted the zip", !existsSync(outPath));
  rmSync(root, { recursive: true, force: true });
}

// ---- layer 4: hardening from the adversarial review (special files, symlink escape, dup paths) ----
async function testHardening() {
  console.log("\n== create_zip hardening: special files, symlink-output escape, duplicate paths ==");
  const root = tmp("errand-zip-hard-");
  const outside = tmp("errand-zip-out-");
  writeFileSync(join(root, "report.txt"), "AAA");

  // Same path listed twice → ONE entry, not a junk "report (2).txt" copy.
  const dup = await createZip.run(
    { files: [join(root, "report.txt"), join(root, "report.txt")], output: join(root, "dup") },
    ctxFor(root, new Journal()),
  );
  check("duplicate source path collapses to one entry", dup.ok && dup.data?.files === 1, dup.ok ? `${dup.data?.files}` : (dup as any).summary);

  // A FIFO source is refused FAST (it would otherwise block readFileSync forever). Skip if mkfifo absent.
  try {
    execFileSync("mkfifo", [join(root, "pipe")]);
    const t0 = Date.now();
    const fifo = await Promise.race([
      createZip.run({ files: [join(root, "pipe")], output: join(root, "fifo") }, ctxFor(root, new Journal())),
      new Promise<{ ok: boolean }>((res) => setTimeout(() => res({ ok: true /* sentinel: hung */ }), 5000)),
    ]);
    check("FIFO source refused without hanging", !fifo.ok && Date.now() - t0 < 5000);
  } catch {
    console.log("SKIP  `mkfifo` unavailable — special-file guard still covered by the isFile() check");
  }

  // A symlinked output dir that points OUTSIDE the root must NOT let the zip escape.
  symlinkSync(outside, join(root, "link"), "dir");
  const esc = await createZip.run({ files: [join(root, "report.txt")], output: join(root, "link", "evil.zip") }, ctxFor(root, new Journal()));
  check("symlinked output dir escape is refused", !esc.ok);
  check("nothing was written outside the sandbox", !existsSync(join(outside, "evil.zip")));

  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

function testValidation() {
  console.log("\n== create_zip argsSchema ==");
  const reg = new Registry().register(createZip);
  check("rejects empty files array", !reg.prepare("create_zip", JSON.stringify({ files: [], output: "x.zip" })).ok);
  check("rejects missing output", !reg.prepare("create_zip", JSON.stringify({ files: ["a.txt"] })).ok);
  check("accepts a valid call", reg.prepare("create_zip", JSON.stringify({ files: ["a.txt"], output: "x.zip" })).ok);
}

async function main() {
  testRoundTrip();
  testSystemUnzip();
  await testTool();
  await testHardening();
  testValidation();
  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

main();
