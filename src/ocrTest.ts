// Verifies image OCR: tesseract.js reads text out of an image, read_file routes images to
// OCR, and detection/fail-soft behave. Slower than the other suites (loads the OCR model on
// first run) and needs the test-fixtures/scan.png image. Run: `npm run ocr:test`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isImageFile, ocrImage } from "./tools/extract.ts";
import { readFile } from "./tools/files.ts";
import type { ToolContext } from "./tools/index.ts";

const FIX = join(process.cwd(), "test-fixtures");
const ctx = { roots: [FIX] } as unknown as ToolContext;
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // Detection (magic bytes authoritative).
  check("isImageFile: PNG magic", isImageFile("x.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  check("isImageFile: JPEG magic", isImageFile("x.jpg", Buffer.from([0xff, 0xd8, 0xff, 0x00])));
  check("isImageFile: PDF is not an image", !isImageFile("x.pdf", Buffer.from("%PDF-1.7")));
  check("isImageFile: plain text is not an image", !isImageFile("x.txt", Buffer.from("hello there")));

  const scan = join(FIX, "scan.png");
  if (existsSync(scan)) {
    const ocr = await ocrImage(readFileSync(scan));
    check("ocrImage: recovered text from image", !!ocr && /mitochondria/i.test(ocr.text) && /powerhouse/i.test(ocr.text));
    check("ocrImage: kind = image", !!ocr && ocr.kind === "image");
    const r = await readFile.run({ path: "scan.png" }, ctx);
    check("read_file(image): ok + OCR text", r.ok && /mitochondria/i.test((r.data as any).text));

    // The hard timeout bounds OCR so read_file can NEVER hang. Force a 1ms ceiling on a real
    // image: recognition can't finish that fast, so the timeout wins → null (honest refusal).
    process.env.OCR_TIMEOUT_MS = "1";
    const timedOut = await ocrImage(readFileSync(scan));
    delete process.env.OCR_TIMEOUT_MS;
    check("ocrImage: timeout fires → null (never hangs)", timedOut === null);
  } else {
    console.log("⚠ SKIP image OCR — test-fixtures/scan.png missing (regen: qlmanage -t -s 1200 -o test-fixtures <txt>)");
  }

  // Fail-soft: garbage in → null (honest refusal), never a crash.
  check("ocrImage: non-image → null (fail-soft)", (await ocrImage(Buffer.from("definitely not an image"))) === null);

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

await main();
