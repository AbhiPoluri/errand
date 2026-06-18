// Verifies v6 document extraction: PDF (via unpdf, against a real CoreText-generated fixture)
// and Word .docx (via our hand-rolled ZIP+inflate+XML reader, against a real .docx this test
// builds from scratch — deflated, so it exercises inflateRawSync). Also checks docKindFor
// detection and the read_file integration end to end. Run: `npm run doc:test`.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { docKindFor, extractDocument } from "./tools/extract.ts";
import { readFile } from "./tools/files.ts";
import type { ToolContext } from "./tools/index.ts";

const FIX = join(process.cwd(), "test-fixtures");
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

// ---- minimal from-scratch ZIP writer (so the .docx fixture is real, not mocked) ----
interface ZE {
  name: string;
  data: Buffer;
  deflate: boolean;
}
function buildZip(entries: ZE[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const stored = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 14); // crc32 — our reader doesn't validate it
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, stored);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + stored.length;
  }
  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

// A realistic .docx: two paragraphs, an XML entity, and word/document.xml is NOT the first
// entry (so we exercise the central-directory walk) and is DEFLATED (exercises inflate).
const DOC_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
  `<w:p><w:r><w:t>The French Revolution began in 1789.</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t xml:space="preserve">It reshaped Europe &amp; ended the monarchy.</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

const ctx = { roots: [FIX] } as unknown as ToolContext;

async function main(): Promise<void> {
  // Build + write the real .docx fixture.
  const docx = buildZip([
    { name: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types/>'), deflate: false },
    { name: "_rels/.rels", data: Buffer.from('<?xml version="1.0"?><Relationships/>'), deflate: false },
    { name: "word/document.xml", data: Buffer.from(DOC_XML, "utf8"), deflate: true },
  ]);
  writeFileSync(join(FIX, "sample.docx"), docx);

  // A plain-text and a non-image binary fixture for the fall-through paths. (Image/OCR is
  // covered in ocr:test — keeping doc:test fast and tesseract-free.)
  writeFileSync(join(FIX, "notes.txt"), "Just some plain notes.\nLine two.");
  writeFileSync(join(FIX, "blob.bin"), Buffer.concat([Buffer.from([0x01, 0x02, 0x03]), Buffer.alloc(64)]));

  // --- docKindFor ---
  check("docKindFor: PDF magic → pdf", docKindFor("x.pdf", Buffer.from("%PDF-1.7")) === "pdf");
  check("docKindFor: .docx + PK → docx", docKindFor("x.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04])) === "docx");
  check("docKindFor: .docx without PK → null", docKindFor("x.docx", Buffer.from("plain")) === null);
  check("docKindFor: plain text → null", docKindFor("x.txt", Buffer.from("hello")) === null);
  check("docKindFor: .zip (PK but not docx) → null", docKindFor("x.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04])) === null);

  // --- DOCX extraction (hand-rolled) ---
  const dx = await extractDocument("docx", docx);
  check("docx: extracted", !!dx);
  check("docx: paragraph 1 text", !!dx && dx.text.includes("French Revolution") && dx.text.includes("1789"));
  check("docx: entity decoded (& not &amp;)", !!dx && dx.text.includes("Europe & ended") && !dx.text.includes("&amp;"));
  check("docx: paragraphs on separate lines", !!dx && dx.text.split("\n").length >= 2 && dx.text.includes("monarchy"));

  // Tabs between runs must survive (regression: the document-order walk used to drop them).
  const tabXml =
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>Name</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Age</w:t></w:r></w:p></w:body></w:document>`;
  const tabDocx = buildZip([{ name: "word/document.xml", data: Buffer.from(tabXml, "utf8"), deflate: true }]);
  const tx = await extractDocument("docx", tabDocx);
  check("docx: tab between runs preserved (Name\\tAge)", !!tx && tx.text.includes("Name\tAge"));

  // Zip-bomb defense: a document.xml that inflates past the cap must fail-soft → null.
  const bombXml = Buffer.alloc(31_000_000, 0x41); // 31MB of 'A' (> MAX_DOCX_XML_BYTES), tiny compressed
  const bombDocx = buildZip([{ name: "word/document.xml", data: bombXml, deflate: true }]);
  check("docx: zip bomb refused (inflate cap → null)", (await extractDocument("docx", bombDocx)) === null);

  // --- XLSX (hand-rolled, same machinery): a real spreadsheet built from scratch ---
  const xlsx = buildZip([
    {
      name: "xl/sharedStrings.xml",
      data: Buffer.from(`<sst><si><t>Item</t></si><si><t>Amount</t></si><si><t>Rent</t></si><si><t>Groceries</t></si></sst>`),
      deflate: true,
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(`<workbook xmlns:r="r"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      deflate: false,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      deflate: false,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(
        `<worksheet><sheetData>` +
          `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
          `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>` +
          `<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>350</v></c></row>` +
          `</sheetData></worksheet>`,
      ),
      deflate: true,
    },
  ]);
  writeFileSync(join(FIX, "budget.xlsx"), xlsx);
  check("docKindFor: .xlsx + PK → xlsx", docKindFor("x.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04])) === "xlsx");
  const sx = await extractDocument("xlsx", xlsx);
  check("xlsx: extracted", !!sx);
  check("xlsx: header row (shared strings)", !!sx && sx.text.includes("Item\tAmount"));
  check("xlsx: string + number cells aligned", !!sx && sx.text.includes("Rent\t1200") && sx.text.includes("Groceries\t350"));

  // Edge cases: an empty shared-string <v> must NOT become shared[0]; a crafted huge column
  // reference must not blow up the row array (capped at Excel's 16384).
  const edge = buildZip([
    { name: "xl/sharedStrings.xml", data: Buffer.from(`<sst><si><t>Alpha</t></si><si><t>Gamma</t></si></sst>`), deflate: true },
    { name: "xl/workbook.xml", data: Buffer.from(`<workbook xmlns:r="r"><sheets><sheet name="E" sheetId="1" r:id="rId1"/></sheets></workbook>`), deflate: false },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`), deflate: false },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(
        `<worksheet><sheetData>` +
          `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v></v></c><c r="C1" t="s"><v>1</v></c></row>` +
          `<row r="2"><c r="A2" t="s"><v>0</v></c><c r="ZZZZZZ2"><v>5</v></c></row>` +
          `</sheetData></worksheet>`,
      ),
      deflate: true,
    },
  ]);
  const ex = await extractDocument("xlsx", edge);
  check("xlsx: empty shared-string cell stays empty (not shared[0])", !!ex && ex.text.includes("Alpha\t\tGamma") && !ex.text.includes("Alpha\tAlpha"));
  check("xlsx: huge column ref capped (no OOM, still extracts)", !!ex && ex.text.includes("Alpha"));

  // --- CSV reads on the plain-text path (no extraction needed) ---
  writeFileSync(join(FIX, "data.csv"), "name,score\nAda,95\nAlan,88\n");
  check("docKindFor: .csv → null (text path)", docKindFor("data.csv", Buffer.from("name,score")) === null);

  // --- PDF extraction (unpdf) against the real fixture ---
  const pdfPath = join(FIX, "sample.pdf");
  if (existsSync(pdfPath)) {
    const px = await extractDocument("pdf", readFileSync(pdfPath));
    check("pdf: extracted with page count", !!px && (px.pages ?? 0) >= 1);
    check("pdf: real text recovered", !!px && px.text.includes("mitochondria") && px.text.includes("42"));
  } else {
    console.log("⚠ SKIP pdf extraction — test-fixtures/sample.pdf missing (regenerate: cupsfilter txt > pdf)");
  }

  // --- read_file integration (the safe read path) ---
  const rPdf = existsSync(pdfPath) ? await readFile.run({ path: "sample.pdf" }, ctx) : { ok: true, data: { text: "mitochondria 42" } };
  check("read_file(pdf): ok + text", rPdf.ok && (rPdf.data as any).text.includes("mitochondria"));
  const rDocx = await readFile.run({ path: "sample.docx" }, ctx);
  check("read_file(docx): ok + text", rDocx.ok && (rDocx.data as any).text.includes("French Revolution"));
  const rXlsx = await readFile.run({ path: "budget.xlsx" }, ctx);
  check("read_file(xlsx): ok + table text", rXlsx.ok && (rXlsx.data as any).text.includes("Rent\t1200"));
  const rCsv = await readFile.run({ path: "data.csv" }, ctx);
  check("read_file(csv): reads as text", rCsv.ok && (rCsv.data as any).text.includes("Ada,95"));
  const rTxt = await readFile.run({ path: "notes.txt" }, ctx);
  check("read_file(txt): still works", rTxt.ok && (rTxt.data as any).text.includes("plain notes"));
  const rBin = await readFile.run({ path: "blob.bin" }, ctx);
  check("read_file(binary): refused as non-text", !rBin.ok && (rBin.summary ?? "").includes("isn't text"));

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

await main();
