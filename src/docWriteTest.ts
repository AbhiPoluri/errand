// save_as_document verification: the OOXML WRITERS round-trip through the existing READERS, the files
// are valid to real apps (macOS `textutil` opens the .docx, `unzip -t` accepts the .xlsx), and the
// tool is sandboxed/non-clobber/undoable. Pure fs + subprocess; no DB, no network. Run: `npm run docwrite:test`.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { buildDocx, buildXlsx, extractDocx, extractXlsx } from "./tools/extract.ts";
import { saveAsDocument } from "./tools/document.ts";
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
  runId: "docwrite-test",
  workspaceRoot: root,
  roots: [root],
});

function testWriters() {
  console.log("\n== buildDocx / buildXlsx round-trip through the readers ==");
  // docx — incl. XML-special chars that must be escaped, blank lines, unicode.
  const docText = 'Report & Notes\n\n<b>Revenue</b> up 12% — "great".\nLine\twith tab';
  const docx = buildDocx(docText);
  const back = extractDocx(docx);
  check("docx round-trips exactly (incl. <,>,&,\" escaping)", back?.text === docText, JSON.stringify(back?.text)?.slice(0, 70));

  // xlsx — strings + numbers + a comma inside a (tab-delimited) cell.
  const rows = [["Name", "Amount"], ["Alpha, Inc", "10"], ["Beta", "20.5"]];
  const xlsx = buildXlsx(rows);
  const xback = extractXlsx(xlsx);
  check("xlsx round-trips (tab-separated, numbers kept)", xback?.text === "Name\tAmount\nAlpha, Inc\t10\nBeta\t20.5", JSON.stringify(xback?.text));

  // Independent validity: macOS textutil (real OOXML reader) opens the docx; unzip -t accepts the xlsx.
  const root = tmp("errand-docval-");
  writeFileSync(join(root, "d.docx"), docx);
  writeFileSync(join(root, "s.xlsx"), xlsx);
  try {
    const t = execFileSync("textutil", ["-convert", "txt", "-stdout", join(root, "d.docx")]).toString();
    check("macOS textutil opens the .docx (valid in real apps)", t.includes("Revenue") && t.includes("great"));
  } catch {
    console.log("SKIP  textutil unavailable");
  }
  try {
    execFileSync("unzip", ["-t", join(root, "s.xlsx")]);
    check("`unzip -t` accepts the .xlsx structure", true);
  } catch (e) {
    check("`unzip -t` accepts the .xlsx structure", false, String((e as any)?.message ?? e));
  }
  rmSync(root, { recursive: true, force: true });
}

async function testTool() {
  console.log("\n== save_as_document tool: scope, suffix, non-clobber, escape, undo ==");
  const root = tmp("errand-docw-");
  const j = new Journal();
  const res = await saveAsDocument.run({ path: join(root, "summary"), kind: "docx", content: "Hello\nWorld" }, ctxFor(root, j));
  const out = join(root, "summary.docx");
  check("tool ok + .docx suffix added", res.ok && res.data?.path === out, res.ok ? "" : (res as any).summary);
  check("file written", existsSync(out));
  check("written file reads back", extractDocx(readFileSync(out))?.text === "Hello\nWorld");
  check("recorded one reversible op", j.reversibleCount() === 1);

  // xlsx + .ext already present (don't double-append)
  const xr = await saveAsDocument.run({ path: join(root, "data.xlsx"), kind: "xlsx", content: "a,b\n1,2" }, ctxFor(root, new Journal()));
  check("xlsx saved at the given .xlsx path", xr.ok && xr.data?.path === join(root, "data.xlsx"));
  check("xlsx reads back (comma-split cells)", extractXlsx(readFileSync(join(root, "data.xlsx")))?.text === "a\tb\n1\t2");

  // non-clobber
  const before = readFileSync(out);
  const dup = await saveAsDocument.run({ path: join(root, "summary.docx"), kind: "docx", content: "X" }, ctxFor(root, new Journal()));
  check("non-clobber: refuses an existing file", !dup.ok);
  check("non-clobber: original untouched", readFileSync(out).equals(before));

  // escape attempts
  const esc = await saveAsDocument.run({ path: "../../etc/evil", kind: "docx", content: "x" }, ctxFor(root, new Journal()));
  check("refuses a path outside the sandbox", !esc.ok);
  const outside = tmp("errand-docw-out-");
  symlinkSync(outside, join(root, "link"), "dir");
  const escSym = await saveAsDocument.run({ path: join(root, "link", "evil"), kind: "docx", content: "x" }, ctxFor(root, new Journal()));
  check("refuses a symlinked-out path", !escSym.ok);
  check("nothing written outside via symlink", !existsSync(join(outside, "evil.docx")));

  // undo
  await j.undoAll();
  check("undo removed the document", !existsSync(out));

  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// Review fixes: control chars, numeric coercion, and the content size cap.
async function testHardening() {
  console.log("\n== hardening (review fixes) ==");
  const root = tmp("errand-doch-");

  // (1) Control chars in content must be STRIPPED so the XML is well-formed — the lenient in-house
  //     reader tolerated them, so verify with strict xmllint against the actual XML parts.
  const ccDocx = buildDocx("clean\x00 then\x07 bell\x1f end");
  const ccXlsx = buildXlsx([["a\x00b", "c\x1fd"]]);
  writeFileSync(join(root, "cc.docx"), ccDocx);
  writeFileSync(join(root, "cc.xlsx"), ccXlsx);
  let haveXmllint = true;
  try {
    execFileSync("which", ["xmllint"]);
  } catch {
    haveXmllint = false;
    console.log("SKIP  xmllint unavailable — control-char well-formedness not strictly checked");
  }
  if (haveXmllint) {
    const wellFormed = (file: string, part: string) => {
      try {
        execSync(`unzip -p '${file}' '${part}' | xmllint --noout -`, { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
    check("docx with control chars is well-formed XML (Word won't reject it)", wellFormed(join(root, "cc.docx"), "word/document.xml"));
    check("xlsx with control chars is well-formed XML (Excel won't reject it)", wellFormed(join(root, "cc.xlsx"), "xl/worksheets/sheet1.xml"));
  }

  // (2) Zip-code / leading-zero / oversized-int values must stay INLINE STRINGS, not numeric cells
  //     (Excel would drop the zeros / lose precision). Inspect the produced sheet XML.
  writeFileSync(join(root, "num.xlsx"), buildXlsx([["02134", "007", "3.10", "10", "20.5", "99999999999999999999"]]));
  const sheet = execSync(`unzip -p '${join(root, "num.xlsx")}' xl/worksheets/sheet1.xml`).toString();
  check("zip code 02134 kept as string (not <v>02134</v>)", sheet.includes(">02134</t>") && !sheet.includes("<v>02134</v>"));
  check("007 kept as string", sheet.includes(">007</t>"));
  check('"3.10" kept as string (not rounded to 3.1)', sheet.includes(">3.10</t>"));
  check("20-digit id kept as string", sheet.includes(">99999999999999999999</t>"));
  check("plain 10 still numeric", sheet.includes("<v>10</v>"));
  check("plain 20.5 still numeric", sheet.includes("<v>20.5</v>"));

  // (3) Oversized content is refused (no OOM via xlsx amplification).
  const big = await saveAsDocument.run({ path: join(root, "big"), kind: "docx", content: "x".repeat(50_000_001) }, ctxFor(root, new Journal()));
  check("rejects content over the size cap", !big.ok);
  check("nothing written for oversized content", !existsSync(join(root, "big.docx")));

  rmSync(root, { recursive: true, force: true });
}

function testValidation() {
  console.log("\n== save_as_document argsSchema ==");
  const reg = new Registry().register(saveAsDocument);
  check("rejects an unknown kind", !reg.prepare("save_as_document", JSON.stringify({ path: "x", kind: "pdf", content: "y" })).ok);
  check("accepts docx", reg.prepare("save_as_document", JSON.stringify({ path: "x", kind: "docx", content: "y" })).ok);
}

async function main() {
  testWriters();
  await testTool();
  await testHardening();
  testValidation();
  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("docwrite:test crashed:", e);
  process.exitCode = 1;
});
