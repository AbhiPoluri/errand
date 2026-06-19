// save_as_document — WRITE a real Word (.docx) or Excel (.xlsx) file (read_file already READS them).
// The binary OOXML is built by buildDocx/buildXlsx (hand-rolled, reusing the zip writer) and is
// round-trip-verified against the existing readers + the system textutil/unzip in doc:write tests.
// Gated + journaled (new file → inverse deletes it), scoped + non-clobber, like create_zip.
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";
import { resolveWithin, assertRealWithin, exists, name, MAX_FILE_BYTES, PathError } from "./fileutil.ts";
import { buildDocx, buildXlsx } from "./extract.ts";
import { deepestExisting } from "./zip.ts";

// xlsx content: rows per line, cells split on TAB if present (preferred — handles commas in data),
// else on comma. Trailing blank line dropped so a text block doesn't leave an empty final row.
function parseRows(content: string): string[][] {
  const lines = content.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  return lines.map((line) => (line.includes("\t") ? line.split("\t") : line.split(",")));
}

export const saveAsDocument: Tool<{ path: string; kind: "docx" | "xlsx"; content: string }, { path: string; kind: string; bytes: number }> = {
  name: "save_as_document",
  modelDescription:
    "Save text as a real Word document (.docx) or spreadsheet (.xlsx) the user can open in Word/Excel/Pages/Numbers. For docx, `content` is the text (each line becomes a paragraph). For xlsx, `content` is rows separated by newlines and cells separated by tabs (preferred) or commas. For a plain .txt/.md/.csv, use write_file instead.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "kind", "content"],
    properties: {
      path: { type: "string", description: "Where to save the file." },
      kind: { type: "string", enum: ["docx", "xlsx"], description: "Word document or spreadsheet." },
      content: { type: "string", description: "docx: the text (a line per paragraph). xlsx: rows by newline, cells by tab/comma." },
    },
  },
  argsSchema: z.object({ path: z.string().min(1), kind: z.enum(["docx", "xlsx"]), content: z.string() }),
  gated: true,
  describe: (a) => {
    // Show the name the file will ACTUALLY get (the run() suffix logic), so the approval card and the
    // created file agree.
    const ext = "." + a.kind;
    const shown = a.path.toLowerCase().endsWith(ext) ? name(a.path) : name(a.path) + ext;
    return {
      action: `Save ${shown} as a ${a.kind === "docx" ? "Word document" : "spreadsheet"}`,
      items: [shown],
      consequences: "You can undo this.",
      reversibility: "reversible",
    };
  },
  summarize: (r) =>
    r.ok ? `Saved ${name(r.data?.path ?? "the document")}.` : (r.summary ?? "I couldn't save that document."),
  run: async (a, ctx): Promise<ToolResult<{ path: string; kind: string; bytes: number }>> => {
    try {
      // Cap input size BEFORE building — xlsx amplifies each cell ~30×+ into in-memory XML, so a huge
      // content string could OOM. Every other file path caps at MAX_FILE_BYTES; this write path must too.
      if (Buffer.byteLength(a.content) > MAX_FILE_BYTES) {
        return { ok: false, error: "too_large", summary: "That's too much text to save as a document safely." };
      }
      // Output: in an allowed root, with the right extension, not clobbering an existing file, and not
      // escaping via a symlinked parent dir (same guards as create_zip).
      const ext = "." + a.kind;
      let outPath = resolveWithin(ctx.roots, a.path);
      if (!outPath.toLowerCase().endsWith(ext)) outPath = resolveWithin(ctx.roots, a.path + ext);
      assertRealWithin(ctx.roots, deepestExisting(outPath));
      if (exists(outPath)) {
        return { ok: false, error: "exists", summary: "A file with that name is already there, so I left it alone — pick another name." };
      }
      const buf = a.kind === "docx" ? buildDocx(a.content) : buildXlsx(parseRows(a.content));
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      ctx.journal.record({
        op: "copy", // a brand-new file; inverse removes it (same shape as copy_file/create_zip)
        description: `Created ${name(outPath)}`,
        reversibility: "reversible",
        manifest: { kind: "copy", to: outPath },
        inverse: async () => rmSync(outPath, { force: true }),
      });
      return { ok: true, data: { path: outPath, kind: a.kind, bytes: buf.length } };
    } catch (e) {
      if (e instanceof PathError) return { ok: false, error: "path", summary: e.userSummary };
      return { ok: false, error: String((e as any)?.message ?? e) };
    }
  },
};
