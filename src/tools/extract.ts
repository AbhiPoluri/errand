// Read-only document text extraction for the safe read path (v6, broadened). The formats
// Errand's non-technical users actually have:
//   - .docx — a ZIP of XML, which we OWN: locate word/document.xml via the ZIP central
//             directory, inflate it (Node's zlib), and strip WordprocessingML to plain text.
//   - .xlsx — also a ZIP of XML (same machinery): resolve the shared-strings table + each
//             sheet's cells into tab-separated rows, one block per sheet. Owned too.
//   - .pdf  — real text extraction needs font/content-stream machinery (subset-font glyph
//             maps, FlateDecode streams, compressed xref). Hand-rolling that would silently
//             emit garbage on real Word-exported PDFs, so we use unpdf (bundled pdfjs). If a
//             PDF yields no text (it's scanned images), we say so honestly rather than guess.
// (.csv needs nothing here — it's already text, so read_file reads it on the plain-text path.)
import { inflateRawSync, deflateRawSync } from "node:zlib";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export type DocKind = "pdf" | "docx" | "xlsx";

export interface Extracted {
  kind: DocKind | "image"; // "image" = text pulled out of a photo/scan via OCR
  text: string;
  pages?: number;
  truncated: boolean;
}

// Mirror read_file's text cap; the tool result is capped again downstream (toToolMessage).
const MAX_DOC_CHARS = 200_000;

// Hard cap on inflated document.xml — defeats a DEFLATE "zip bomb" (a tiny compressed entry
// that decompresses to gigabytes) that would OOM the runtime. Deliberately FAR above
// MAX_DOC_CHARS: raw WordprocessingML markup is many times larger than the plain text we
// pull from it, so a legitimate long essay stays well under this while a bomb throws
// (→ caught below → honest null → calm "couldn't read it" refusal).
const MAX_DOCX_XML_BYTES = 30_000_000;

// Decide whether a file is an extractable document. Magic bytes are authoritative (a PDF is a
// PDF whatever the name); .docx/.xlsx are all ZIPs ("PK"), so we additionally gate on the
// extension to tell them apart (and from a plain .zip). Returns null for everything else (the
// caller falls through to normal text/binary handling — including .csv, which reads as text).
export function docKindFor(path: string, head: Buffer): DocKind | null {
  if (head.length >= 5 && head.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  const lower = path.toLowerCase();
  const isZip = head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b;
  if (isZip && lower.endsWith(".docx")) return "docx";
  if (isZip && lower.endsWith(".xlsx")) return "xlsx";
  return null;
}

export async function extractDocument(kind: DocKind, buf: Buffer): Promise<Extracted | null> {
  if (kind === "pdf") return extractPdf(buf);
  if (kind === "xlsx") return extractXlsx(buf);
  return extractDocx(buf);
}

// ---- PDF (unpdf / pdfjs) ----
async function extractPdf(buf: Buffer): Promise<Extracted | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf"); // lazy: only when a PDF is read
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const t: unknown = text; // mergePages:true types this as string; stay defensive anyway
    const clean = tidy(typeof t === "string" ? t : Array.isArray(t) ? t.join("\n\n") : "");
    if (!clean) return null; // opened but no extractable text (scanned images) → honest refusal
    return { kind: "pdf", text: clean.slice(0, MAX_DOC_CHARS), pages: totalPages, truncated: clean.length > MAX_DOC_CHARS };
  } catch {
    return null;
  }
}

// ---- Image OCR (tesseract.js) — read text out of a photo / screenshot / scan ----
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp"]);

// Is this an image we can OCR? Magic bytes are authoritative; extension is a fallback. (If a
// non-image slips through, OCR just yields nothing → null → the caller's honest refusal.)
export function isImageFile(path: string, head: Buffer): boolean {
  const b = head;
  if (b.length >= 4) {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true; // GIF8
    if (b[0] === 0x42 && b[1] === 0x4d) return true; // BMP
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return true; // TIFF
    if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return true; // WEBP
  }
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return IMAGE_EXTS.has(ext);
}

// Hard ceiling on the WHOLE OCR op (model init + recognition). tesseract.js has no internal
// timeout and can HANG indefinitely with the promise unsettled — a cold/offline model fetch,
// a pathologically large image, or a worker thread that dies without sending a reject message
// all freeze the await. Without this bound, read_file (and the whole turn) would hang — the
// worst outcome for a trust-first tool. On timeout we fail soft → the honest image refusal.
// Read per-call (not at module load) so it's overridable in tests. (default 45s)
const ocrTimeoutMs = (): number => Number(process.env.OCR_TIMEOUT_MS) || 45_000;
// Stable cache dir for the downloaded language model so it isn't re-fetched from the CDN every
// call (default is CWD). First online call downloads it; an offline first call fails soft via
// the timeout above rather than hanging.
const OCR_CACHE_DIR = join(process.cwd(), ".tesseract-cache");

// OCR an image to text. Returns null if OCR fails, times out, OR finds no readable text (so
// the caller says "it's an image, no text" honestly rather than claiming success on an empty
// result). Lazy import; the worker is ALWAYS torn down — even on the timeout path, and even if
// the timeout wins before recognition finishes — so a slow/hung worker can't leak or hang.
export async function ocrImage(buf: Buffer): Promise<Extracted | null> {
  let worker: any = null; // tesseract.js Worker (lazy-imported; typed loosely on purpose)
  // Idempotent teardown — called both when `run` settles AND on the timeout path, so a worker
  // that is mid-recognize or hung when we time out is reclaimed immediately (can't leak / keep
  // the process alive), while a normal completion terminates exactly once.
  const terminate = async (): Promise<void> => {
    if (!worker) return;
    const w = worker;
    worker = null;
    try {
      await w.terminate();
    } catch {
      /* terminating a crashed/zombie worker can throw — ignore */
    }
  };
  // This inner promise NEVER rejects — every failure resolves to null — so racing it against
  // the timeout can't leak an unhandled rejection when the timeout wins.
  const run = (async (): Promise<string | null> => {
    try {
      try {
        mkdirSync(OCR_CACHE_DIR, { recursive: true });
      } catch {
        /* cache dir is best-effort; OCR still works, it just re-downloads next time */
      }
      const { createWorker } = await import("tesseract.js");
      // errorHandler is ESSENTIAL: on un-decodable image data tesseract.js rejects the
      // recognize() promise AND ALSO `throw`s the same error from a worker message handler
      // (an UNCAUGHT exception that try/catch can't catch → it would crash the whole server).
      // Providing errorHandler replaces that throw with this no-op; the rejection still flows
      // to the catch below → null → honest refusal.
      worker = await createWorker("eng", undefined, { errorHandler: () => {}, cachePath: OCR_CACHE_DIR });
      const { data } = await worker.recognize(buf);
      const text = tidy(data?.text ?? "");
      return text || null;
    } catch {
      return null;
    }
  })();
  // Catches the case where the timeout already returned but the worker is created LATER (slow
  // init) and then finishes/hangs — reclaim it whenever run finally settles.
  void run.finally(terminate);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ocrTimeoutMs());
  });
  try {
    const text = await Promise.race([run, timeout]);
    if (!text) return null;
    return { kind: "image", text: text.slice(0, MAX_DOC_CHARS), truncated: text.length > MAX_DOC_CHARS };
  } finally {
    if (timer) clearTimeout(timer);
    // Fire-and-forget so worker cleanup can NEVER delay or re-hang the response — terminate()
    // on a hung worker is best-effort, and run.finally(terminate) also reclaims it. This keeps
    // the no-hang guarantee independent of how tesseract's terminate() behaves.
    void terminate();
  }
}

// ---- DOCX (hand-rolled: ZIP central directory + DEFLATE + WordprocessingML → text) ----
export function extractDocx(buf: Buffer): Extracted | null {
  const xml = readZipEntry(buf, "word/document.xml");
  if (!xml) return null;
  const full = tidy(docxXmlToText(xml.toString("utf8")));
  if (!full) return null;
  return { kind: "docx", text: full.slice(0, MAX_DOC_CHARS), truncated: full.length > MAX_DOC_CHARS };
}

// ---- XLSX (hand-rolled, same ZIP machinery): shared strings + each sheet's cells → a
// tab-separated table, one block per sheet, columns aligned by their A1-style references. ----
export function extractXlsx(buf: Buffer): Extracted | null {
  const sharedRaw = readZipEntry(buf, "xl/sharedStrings.xml");
  const shared = sharedRaw ? parseSharedStrings(sharedRaw.toString("utf8")) : [];
  const sheets = discoverSheets(buf);
  if (!sheets.length) return null;
  const blocks: string[] = [];
  for (const sheet of sheets) {
    const raw = readZipEntry(buf, sheet.path);
    if (!raw) continue;
    const table = sheetToText(raw.toString("utf8"), shared);
    if (table.trim()) blocks.push(sheets.length > 1 ? `Sheet: ${sheet.name}\n${table}` : table);
  }
  const full = tidy(blocks.join("\n\n"));
  if (!full) return null;
  return { kind: "xlsx", text: full.slice(0, MAX_DOC_CHARS), truncated: full.length > MAX_DOC_CHARS };
}

// The workbook's shared-strings table: each <si> is one string (its <t> runs concatenated).
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1]))) text += decodeXmlEntities(tm[1]);
    out.push(text);
  }
  return out;
}

// Map each <sheet name=… r:id=…> in the workbook to its worksheet part via the rels file,
// preserving sheet order + names. Falls back to xl/worksheets/sheetN.xml if rels are absent.
function discoverSheets(buf: Buffer): { name: string; path: string }[] {
  const wb = readZipEntry(buf, "xl/workbook.xml");
  if (!wb) return [];
  const relsRaw = readZipEntry(buf, "xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  if (relsRaw) {
    const rels = relsRaw.toString("utf8");
    const rRe = /<Relationship\b[^>]*\/>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rRe.exec(rels))) {
      const id = /Id="([^"]+)"/.exec(rm[0])?.[1];
      const target = /Target="([^"]+)"/.exec(rm[0])?.[1];
      // Targets are relative to xl/; normalize "/xl/…" or "xl/…" or "worksheets/…" to "xl/…".
      if (id && target) relMap.set(id, "xl/" + target.replace(/^\/?xl\//, "").replace(/^\//, ""));
    }
  }
  const sheets: { name: string; path: string }[] = [];
  const sRe = /<sheet\b[^>]*\/?>/g;
  const wbXml = wb.toString("utf8");
  let sm: RegExpExecArray | null;
  while ((sm = sRe.exec(wbXml))) {
    const name = decodeXmlEntities(/name="([^"]+)"/.exec(sm[0])?.[1] ?? `Sheet${sheets.length + 1}`);
    const rid = /r:id="([^"]+)"/.exec(sm[0])?.[1];
    const path = (rid && relMap.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, path });
  }
  return sheets;
}

// One worksheet's <sheetData> → rows of tab-separated cell values, columns placed by their
// A1 reference so gaps stay aligned. Resolves shared-string, inline-string, boolean + numbers.
function sheetToText(xml: string, shared: string[]): string {
  const rows: string[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const cells: string[] = [];
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] ?? cm[3] ?? "";
      const col = colIndex(/r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "");
      const val = cellValue(/t="([^"]+)"/.exec(attrs)?.[1], cm[2] ?? "", shared);
      // Bound the column index to Excel's real maximum (XFD=16384) so a crafted r="ZZZZZZ1"
      // can't make the gap-fill below allocate a giant array (OOM). Out-of-range → append.
      if (col >= 0 && col < 16384) {
        while (cells.length < col) cells.push("");
        cells[col] = val;
      } else if (val) {
        cells.push(val);
      }
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

function cellValue(type: string | undefined, body: string, shared: string[]): string {
  if (type === "s") {
    const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
    if (raw == null || raw.trim() === "") return ""; // empty/missing <v> must NOT collapse to shared[0]
    const idx = Number(raw);
    return Number.isInteger(idx) && idx >= 0 ? (shared[idx] ?? "") : "";
  }
  if (type === "inlineStr") {
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(body))) text += decodeXmlEntities(tm[1]);
    return text;
  }
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (v == null) return "";
  if (type === "b") return v === "1" ? "TRUE" : "FALSE";
  return decodeXmlEntities(v); // number or formula-result string
}

// "A"→0, "B"→1, … "Z"→25, "AA"→26. Returns -1 for an empty/missing reference.
function colIndex(letters: string): number {
  if (!letters) return -1;
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

// ---- ZIP enumeration (generalizes readZipEntry's central-directory walk for extract_zip) ----
export interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOff: number;
}

// Enumerate ALL entries from the ZIP central directory. [] if the archive is unreadable.
export function listZipEntries(zip: Buffer): ZipEntry[] {
  if (zip.length < 22) return [];
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const cdCount = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    out.push({ name: zip.toString("utf8", p + 46, p + 46 + nameLen), method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Decompress one enumerated entry's bytes (stored or deflate), or null. Bombs are capped.
export function inflateZipEntry(zip: Buffer, e: ZipEntry): Buffer | null {
  if (e.localOff + 30 > zip.length || zip.readUInt32LE(e.localOff) !== 0x04034b50) return null;
  const lNameLen = zip.readUInt16LE(e.localOff + 26);
  const lExtraLen = zip.readUInt16LE(e.localOff + 28);
  const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
  const data = zip.subarray(dataStart, dataStart + e.compSize);
  try {
    return e.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: MAX_DOCX_XML_BYTES });
  } catch {
    return null;
  }
}

// Pull one entry's decompressed bytes out of a ZIP by exact filename, or null if absent.
// Reads the compressed size from the CENTRAL directory (authoritative even when a data
// descriptor zeroes it in the local header), and the data offset from the local header
// (whose name/extra lengths can differ from the central record).
function readZipEntry(zip: Buffer, want: string): Buffer | null {
  if (zip.length < 22) return null;
  // Find End Of Central Directory (signature PK\x05\x06), scanning back past any comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cdCount = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const fname = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (fname === want) {
      if (localOff + 30 > zip.length || zip.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compSize);
      try {
        // 0 = stored (bounded by the on-disk file size), 8 = deflate (cap defeats zip bombs).
        return method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: MAX_DOCX_XML_BYTES });
      } catch {
        return null;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// WordprocessingML → plain text: paragraphs become lines; the literal text lives in <w:t>.
function docxXmlToText(xml: string): string {
  const s = xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n") // end of paragraph → newline
    .replace(/<w:p\b[^>]*\/>/g, "\n"); // self-closed (empty) paragraph
  // Walk in document order, keeping <w:t> text plus the structural tabs/newlines made above.
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|[\n\t]/g;
  let out = "";
  let m: RegExpExecArray | null;
  // m[0] is either a structural whitespace char (keep verbatim) or a <w:t> block (decode it).
  while ((m = re.exec(s))) out += m[0] === "\n" || m[0] === "\t" ? m[0] : decodeXmlEntities(m[1]);
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // ampersand LAST so we never double-decode
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

// Collapse trailing spaces and runs of blank lines so the model gets clean prose.
function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- ZIP writer (the mirror of the reader above) ----
// Own every byte: a self-contained CRC-32 (IEEE polynomial, reflected) + a minimal ZIP builder.
// The output is read back by listZipEntries/inflateZipEntry above — round-trip verified in zip:test
// and cross-checked against the system `unzip`.

let CRC_TABLE: Uint32Array | null = null;
export function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInput {
  name: string; // entry path inside the archive (forward slashes); caller sanitizes
  data: Buffer;
}

// DOS modification time/date fields. We stamp a fixed valid minimum (1980-01-01 00:00) rather than
// the real clock so the output is deterministic (and `new Date()` stays out of the format layer).
const DOS_DATE = 0x0021; // 1980-01-01 — the minimum valid DOS date (day/month 0 is illegal)
const DOS_TIME = 0x0000; // 00:00:00

// Build a valid ZIP archive from in-memory files. Each entry is DEFLATEd when that actually shrinks
// it (never inflates already-compressed bytes), else STOREd. UTF-8 filenames (general-purpose bit
// 11). Layout = [local record]* [central record]* [EOCD], matching the reader's offsets exactly.
export function buildZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0; // running byte offset of each local header from the start of the archive
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const uncompSize = entry.data.length;
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data);
    const useDeflate = deflated.length < uncompSize; // only when it helps
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : entry.data;
    const compSize = body.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(0x0800, 6); // general-purpose flag: UTF-8 name
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 name
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // offset of this entry's local header
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const localDir = Buffer.concat(locals);
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // this disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir start
  eocd.writeUInt16LE(entries.length, 8); // CD records on this disk
  eocd.writeUInt16LE(entries.length, 10); // total CD records
  eocd.writeUInt32LE(centralDir.length, 12); // size of central directory
  eocd.writeUInt32LE(localDir.length, 16); // offset of central directory (= bytes before it)
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([localDir, centralDir, eocd]);
}

// ---- OOXML WRITERS (the mirror of extractDocx/extractXlsx) ----
// A .docx/.xlsx is a ZIP of XML parts, so these reuse buildZip above. Kept deliberately MINIMAL —
// just the parts Word/Excel require to open the file — and round-trip-verified by reading them back
// with extractDocx/extractXlsx (and validated by the system `textutil`/`unzip` in doc:write tests).
const X = (s: string) =>
  s
    // Strip XML-1.0-ILLEGAL C0 control chars first (keep \t \n \r). They have no escape and would make
    // the part malformed — Word/Excel reject the file as corrupt even though our lenient reader tolerates it.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const DOCX_CONTENT_TYPES =
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";
const ROOT_RELS_DOCX =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

// Plain text → a .docx. Each line becomes a paragraph (a blank line → an empty paragraph), so the
// text round-trips through extractDocx line-for-line.
export function buildDocx(text: string): Buffer {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const paras = lines
    .map((ln) => (ln === "" ? "<w:p/>" : `<w:p><w:r><w:t xml:space="preserve">${X(ln)}</w:t></w:r></w:p>`))
    .join("");
  const doc =
    XML_DECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paras +
    "<w:sectPr/></w:body></w:document>";
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(DOCX_CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS_DOCX, "utf8") },
    { name: "word/document.xml", data: Buffer.from(doc, "utf8") },
  ]);
}

const XLSX_CONTENT_TYPES =
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  "</Types>";
const ROOT_RELS_XLSX =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";
const WORKBOOK =
  XML_DECL +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
const WORKBOOK_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  "</Relationships>";

// 0→"A", 25→"Z", 26→"AA" — the inverse of colIndex() above.
function colLetter(n: number): string {
  let s = "";
  n++;
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// A grid of cells → a single-sheet .xlsx. A cell that's a plain number is written as a numeric cell;
// everything else as an inline string. Round-trips through extractXlsx (tab-separated, by A1 ref).
export function buildXlsx(rows: string[][]): Buffer {
  const rowXml = rows
    .map((cells, ri) => {
      const cs = cells
        .map((cell, ci) => {
          const ref = colLetter(ci) + (ri + 1);
          const v = cell ?? "";
          // Numeric cell ONLY when the value round-trips losslessly as a JS number — so "007",
          // "02134" (zip codes), "3.10", and >15-digit IDs stay inline strings (Excel would
          // otherwise drop the leading zeros / lose precision past 2^53).
          if (v !== "" && Number.isFinite(Number(v)) && String(Number(v)) === v) return `<c r="${ref}"><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${X(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cs}</row>`;
    })
    .join("");
  const sheet =
    XML_DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rowXml +
    "</sheetData></worksheet>";
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(XLSX_CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS_XLSX, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(WORKBOOK, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(WORKBOOK_RELS, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") },
  ]);
}
