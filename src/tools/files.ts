// Structured file tools (decision #4's "default path"). Each is sandboxed to the
// allowed roots, describes itself in human terms, and — for mutations — records a
// journal entry with a REAL inverse so Undo is structural:
//   write  -> snapshot prior bytes (or delete if new)
//   move   -> move back
//   copy   -> delete the copy
//   delete -> move to .errand-review/<runId>/ (never unlink), then move back to undo
import {
  readFileSync,
  writeFileSync,
  renameSync,
  cpSync,
  rmSync,
  rmdirSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";
import {
  resolveWithin,
  assertRealWithin,
  isBinary,
  exists,
  name,
  MAX_READ_BYTES,
  MAX_FILE_BYTES,
  PathError,
} from "./fileutil.ts";
import { docKindFor, extractDocument, isImageFile, ocrImage } from "./extract.ts";

// Human phrasing for a move/copy: "into <folder>" when relocating, "to <name>" when renaming.
function relocationPhrase(verb: string, from: string, to: string): string {
  const sameDir = dirname(from) === dirname(to);
  return sameDir ? `${verb} ${name(from)} to ${name(to)}` : `${verb} ${name(from)} into ${name(dirname(to))}`;
}

// Reached only for non-image binaries (images route to OCR first) — keep it generic.
function binaryRefusal(): string {
  return "That file isn't text, so I can't read it.";
}

function fail(e: unknown): ToolResult {
  if (e instanceof PathError) return { ok: false, error: "path", summary: e.userSummary };
  return { ok: false, error: String((e as any)?.message ?? e) };
}

// ---- list_files (read-only) ----
export const listFiles: Tool<{ dir?: string }> = {
  name: "list_files",
  modelDescription: "List the files and folders inside a directory. Read-only.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: { dir: { type: "string", description: "Folder to list (default: the working folder)." } },
  },
  argsSchema: z.object({ dir: z.string().optional() }),
  gated: false,
  describe: (a) => ({ action: `Looking at what's in ${a.dir ? name(a.dir) : "the folder"}`, reversibility: "reversible" }),
  summarize: (r) => (r.ok ? `Found ${(r.data as any[])?.length ?? 0} item(s).` : "I couldn't open that folder."),
  run: async (a, ctx) => {
    try {
      const abs = resolveWithin(ctx.roots, a.dir ?? ".");
      assertRealWithin(ctx.roots, abs);
      const entries = readdirSync(abs, { withFileTypes: true }).map((d) => {
        const kind = d.isDirectory() ? "folder" : "file";
        let size = 0;
        try {
          size = d.isFile() ? statSync(join(abs, d.name)).size : 0;
        } catch {}
        return { name: d.name, kind, size };
      });
      return { ok: true, data: entries };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- read_file (read-only) ----
export const readFile: Tool<{ path: string }> = {
  name: "read_file",
  modelDescription:
    "Read the text of a file — plain text, code, CSV, Markdown, a PDF, a Word (.docx) document, or an Excel (.xlsx) spreadsheet. Read-only; PDFs, Word docs, and spreadsheets are converted to text automatically. It can also pull text out of an image or photo (a screenshot, a scan, a picture of a page) via OCR. Other non-text files can't be read.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", description: "File to read." } },
  },
  argsSchema: z.object({ path: z.string().min(1) }),
  gated: false,
  describe: (a) => ({ action: `Reading ${name(a.path)}`, reversibility: "reversible" }),
  summarize: (r) => {
    if (!r.ok) return r.summary ?? "I couldn't read that file.";
    const d = r.data as any;
    const where = name(d?.path ?? "the file");
    return d?.pages ? `Read ${where} (${d.pages} page${d.pages === 1 ? "" : "s"}).` : `Read ${where}.`;
  },
  run: async (a, ctx) => {
    try {
      const abs = resolveWithin(ctx.roots, a.path);
      assertRealWithin(ctx.roots, abs);
      // Refuse pathologically large files BEFORE loading them into memory (OOM guard).
      if (statSync(abs).size > MAX_FILE_BYTES) {
        return { ok: false, error: "too_large", summary: "That file is too big for me to open safely." };
      }
      const buf = readFileSync(abs);
      // PDF / Word documents: extract their text instead of refusing them as binary.
      const kind = docKindFor(abs, buf);
      if (kind) {
        const doc = await extractDocument(kind, buf);
        if (!doc) {
          return {
            ok: false,
            error: "extract",
            summary:
              kind === "pdf"
                ? "I opened the PDF but couldn't pull any readable text from it — it may be scanned images rather than text."
                : "I opened the document but couldn't read its text.",
          };
        }
        return {
          ok: true,
          data: { path: abs, text: doc.text, truncated: doc.truncated, kind: doc.kind, pages: doc.pages },
          bytes: buf.length,
        };
      }
      // Image / photo / scan: OCR the text out of it (read-only). If there's no readable
      // text, say so honestly instead of pretending to have read a document.
      if (isImageFile(abs, buf)) {
        const ocr = await ocrImage(buf);
        if (ocr) {
          return { ok: true, data: { path: abs, text: ocr.text, truncated: ocr.truncated, kind: ocr.kind }, bytes: buf.length };
        }
        return { ok: false, error: "ocr", summary: "That's an image, and I couldn't find any readable text in it." };
      }
      if (isBinary(buf)) return { ok: false, error: "binary", summary: binaryRefusal() };
      const text = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
      return { ok: true, data: { path: abs, text, truncated: buf.length > MAX_READ_BYTES }, bytes: buf.length };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- write_file (gated, reversible) ----
export const writeFile: Tool<{ path: string; content: string }> = {
  name: "write_file",
  modelDescription: "Create or overwrite a text file with the given content.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "File to write." },
      content: { type: "string", description: "Full text content to write." },
    },
  },
  argsSchema: z.object({ path: z.string().min(1), content: z.string() }),
  gated: true,
  describe: (a) => {
    const existed = (() => {
      try {
        return exists(a.path);
      } catch {
        return false;
      }
    })();
    return {
      action: `${existed ? "Update" : "Create"} the file ${name(a.path)}`,
      items: [name(a.path)],
      consequences: "You can undo this.",
      reversibility: "reversible",
    };
  },
  summarize: (r) => (r.ok ? `Saved ${name((r.data as any)?.path ?? "the file")}.` : (r.summary ?? "I couldn't save that file.")),
  run: async (a, ctx) => {
    try {
      const abs = resolveWithin(ctx.roots, a.path);
      const existedBefore = exists(abs);
      if (existedBefore) assertRealWithin(ctx.roots, abs);
      const prior = existedBefore ? readFileSync(abs) : null;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, a.content, "utf8");
      ctx.journal.record({
        op: "write",
        description: `${existedBefore ? "Updated" : "Created"} ${name(abs)}`,
        reversibility: "reversible",
        inverse: async () => {
          if (prior === null) rmSync(abs, { force: true });
          else writeFileSync(abs, prior);
        },
      });
      return { ok: true, data: { path: abs }, bytes: Buffer.byteLength(a.content) };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- make_folder (gated, reversible) — the structured way to create a folder, so
// the model never reaches for bash `mkdir`. Inverse removes the folder only if it's
// still empty (never deletes a folder the user later filled). ----
export const makeFolder: Tool<{ path: string }> = {
  name: "make_folder",
  modelDescription: "Create a new, empty folder. Use this instead of a shell command to make folders.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", description: "Folder to create." } },
  },
  argsSchema: z.object({ path: z.string().min(1) }),
  gated: true,
  describe: (a) => ({
    action: `Make a new folder called ${name(a.path)}`,
    items: [name(a.path)],
    consequences: "You can undo this.",
    reversibility: "reversible",
  }),
  summarize: (r) => (r.ok ? `Made the folder ${name((r.data as any)?.path ?? "")}.` : (r.summary ?? "I couldn't make that folder.")),
  run: async (a, ctx) => {
    try {
      const abs = resolveWithin(ctx.roots, a.path);
      if (exists(abs)) return { ok: false, error: "exists", summary: "That folder is already there." };
      mkdirSync(abs, { recursive: true });
      ctx.journal.record({
        op: "make_folder",
        description: `Made the folder ${name(abs)}`,
        reversibility: "reversible",
        inverse: async () => {
          try {
            rmdirSync(abs); // removes only if still empty; throws (and we leave it) if filled
          } catch {
            /* user filled it — leave it */
          }
        },
      });
      return { ok: true, data: { path: abs } };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- move (gated, reversible) ----
export const moveFile: Tool<{ from: string; to: string }> = {
  name: "move_file",
  modelDescription: "Move or rename a file or folder. Refuses if the destination already exists.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to"],
    properties: {
      from: { type: "string", description: "Source path." },
      to: { type: "string", description: "Destination path." },
    },
  },
  argsSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  gated: true,
  describe: (a) => ({
    action: relocationPhrase("Move", a.from, a.to),
    items: [name(a.from)],
    consequences: "You can undo this.",
    reversibility: "reversible",
  }),
  summarize: (r) => (r.ok ? `Moved ${name((r.data as any)?.from ?? "it")}.` : (r.summary ?? "I couldn't move that.")),
  run: async (a, ctx) => {
    try {
      const from = resolveWithin(ctx.roots, a.from);
      const to = resolveWithin(ctx.roots, a.to);
      assertRealWithin(ctx.roots, from);
      if (!exists(from)) return { ok: false, error: "missing", summary: "I couldn't find that file to move." };
      if (exists(to)) return { ok: false, error: "collision", summary: "Something's already there, so I left it alone." };
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      ctx.journal.record({
        op: "move",
        description: `Moved ${name(from)} to ${name(to)}`,
        reversibility: "reversible",
        inverse: async () => renameSync(to, from),
      });
      return { ok: true, data: { from, to } };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- copy (gated, reversible) ----
export const copyFile: Tool<{ from: string; to: string }> = {
  name: "copy_file",
  modelDescription: "Copy a file or folder to a new location. Refuses if the destination already exists.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to"],
    properties: {
      from: { type: "string", description: "Source path." },
      to: { type: "string", description: "Destination path." },
    },
  },
  argsSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  gated: true,
  describe: (a) => ({
    action: relocationPhrase("Copy", a.from, a.to),
    items: [name(a.from)],
    consequences: "You can undo this.",
    reversibility: "reversible",
  }),
  summarize: (r) => (r.ok ? `Copied ${name((r.data as any)?.from ?? "it")}.` : (r.summary ?? "I couldn't copy that.")),
  run: async (a, ctx) => {
    try {
      const from = resolveWithin(ctx.roots, a.from);
      const to = resolveWithin(ctx.roots, a.to);
      assertRealWithin(ctx.roots, from);
      if (!exists(from)) return { ok: false, error: "missing", summary: "I couldn't find that file to copy." };
      if (exists(to)) return { ok: false, error: "collision", summary: "Something's already there, so I left it alone." };
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      ctx.journal.record({
        op: "copy",
        description: `Copied ${name(from)} to ${name(to)}`,
        reversibility: "reversible",
        inverse: async () => rmSync(to, { recursive: true, force: true }),
      });
      return { ok: true, data: { from, to } };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- delete (gated, reversible via Review folder — NEVER unlink) ----
export const deleteFile: Tool<{ path: string }> = {
  name: "delete_file",
  modelDescription:
    "Remove a file or folder. It is moved to a Review folder (recoverable), never permanently deleted.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", description: "File or folder to remove." } },
  },
  argsSchema: z.object({ path: z.string().min(1) }),
  gated: true,
  describe: (a) => ({
    action: `Remove ${name(a.path)}`,
    items: [name(a.path)],
    consequences: "This goes to a Review folder, not gone forever.",
    reversibility: "reversible",
  }),
  summarize: (r) =>
    r.ok ? `Moved ${name((r.data as any)?.original ?? "it")} to a Review folder.` : (r.summary ?? "I couldn't remove that."),
  run: async (a, ctx) => {
    try {
      const abs = resolveWithin(ctx.roots, a.path);
      assertRealWithin(ctx.roots, abs);
      if (!exists(abs)) return { ok: false, error: "missing", summary: "I couldn't find that to remove." };
      const reviewDir = join(ctx.workspaceRoot, ".errand-review", ctx.runId);
      mkdirSync(reviewDir, { recursive: true });
      const dest = join(reviewDir, name(abs));
      renameSync(abs, dest);
      ctx.journal.record({
        op: "delete",
        description: `Moved ${name(abs)} to the Review folder`,
        reversibility: "reversible",
        inverse: async () => renameSync(dest, abs),
      });
      return { ok: true, data: { original: abs, review: dest } };
    } catch (e) {
      return fail(e);
    }
  },
};

export const fileTools = [listFiles, readFile, makeFolder, writeFile, moveFile, copyFile, deleteFile];
