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
      // Snapshot prior bytes to disk so this write is undoable even AFTER a restart (when the
      // in-memory `prior` buffer is gone). Best-effort: if snapshotting fails, snapshot stays
      // null and restart-undo refuses to touch the file rather than risk deleting it.
      let snapshot: string | null = null;
      if (prior !== null) {
        try {
          const snapDir = join(ctx.workspaceRoot, ".errand-review", ctx.runId, ".snapshots");
          mkdirSync(snapDir, { recursive: true });
          snapshot = join(snapDir, crypto.randomUUID());
          writeFileSync(snapshot, prior);
        } catch {
          snapshot = null;
        }
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, a.content, "utf8");
      ctx.journal.record({
        op: "write",
        description: `${existedBefore ? "Updated" : "Created"} ${name(abs)}`,
        reversibility: "reversible",
        manifest: { kind: "write", path: abs, wasNew: !existedBefore, snapshot },
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
        manifest: { kind: "make_folder", path: abs },
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
        manifest: { kind: "move", from, to },
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
        manifest: { kind: "copy", to },
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
      // Disambiguate by basename: deleting two files that share a name (a/notes.txt,
      // b/notes.txt) must NOT have the second renameSync clobber the first parked copy —
      // that would lose the first file's bytes and make its undo restore the wrong content.
      const base = join(reviewDir, name(abs));
      let dest = base;
      for (let n = 1; exists(dest); n++) dest = `${base}.${n}`;
      renameSync(abs, dest);
      ctx.journal.record({
        op: "delete",
        description: `Moved ${name(abs)} to the Review folder`,
        reversibility: "reversible",
        manifest: { kind: "delete", from: abs, dest },
        inverse: async () => renameSync(dest, abs),
      });
      return { ok: true, data: { original: abs, review: dest } };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- rename_file (gated, reversible) — rename in place within the same folder ----
// Distinct from move_file: non-technical users say "rename", and a bare-basename rename can't
// relocate or escape scope, so it reads honestly in the timeline ("Rename X to Y", not "Move").
export const renameFile: Tool<{ path: string; newName: string }> = {
  name: "rename_file",
  modelDescription:
    "Rename a file or folder in place (it stays in the same folder). Give just the new name, not a path.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "newName"],
    properties: {
      path: { type: "string", description: "The file or folder to rename." },
      newName: { type: "string", description: "The new name only — no slashes, no folders." },
    },
  },
  argsSchema: z.object({
    path: z.string().min(1),
    // A bare basename: no path separators, and not a "." / ".." segment. The slash bans make
    // traversal impossible, so only the two literal traversal segments need rejecting — a ".."
    // SUBSTRING (e.g. "data..clean.csv") is a perfectly valid filename. resolveWithin re-checks scope.
    newName: z
      .string()
      .min(1)
      .refine((n) => !n.includes("/") && !n.includes("\\") && n !== "." && n !== "..", {
        message: "must be a plain name, not a path",
      }),
  }),
  gated: true,
  describe: (a) => ({
    action: `Rename ${name(a.path)} to ${a.newName}`,
    items: [name(a.path)],
    consequences: "You can undo this.",
    reversibility: "reversible",
  }),
  summarize: (r) => (r.ok ? `Renamed to ${name((r.data as any)?.to ?? "")}.` : (r.summary ?? "I couldn't rename that.")),
  run: async (a, ctx) => {
    try {
      const from = resolveWithin(ctx.roots, a.path);
      assertRealWithin(ctx.roots, from);
      if (!exists(from)) return { ok: false, error: "missing", summary: "I couldn't find that to rename." };
      const to = join(dirname(from), a.newName);
      resolveWithin(ctx.roots, to); // re-confirm the new name still lands inside an allowed root
      if (exists(to)) return { ok: false, error: "collision", summary: "Something with that name is already there, so I left it alone." };
      renameSync(from, to);
      ctx.journal.record({
        op: "move",
        description: `Renamed ${name(from)} to ${a.newName}`,
        reversibility: "reversible",
        manifest: { kind: "move", from, to },
        inverse: async () => renameSync(to, from),
      });
      return { ok: true, data: { from, to } };
    } catch (e) {
      return fail(e);
    }
  },
};

// ---- folder_summary (read-only) — bounded recursive disk-usage so "what's taking up
// space?" / "free up room" works (list_files only sees one level). Strictly read-only. ----
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const folderSummary: Tool<{ dir?: string }> = {
  name: "folder_summary",
  modelDescription:
    "Summarize how much space a folder uses, recursively: total size, the biggest files, the biggest sub-folders, and a breakdown by file type. Read-only. Use this for 'what's taking up space' or 'help me free up room'.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: { dir: { type: "string", description: "Folder to summarize (default: the working folder)." } },
  },
  argsSchema: z.object({ dir: z.string().optional() }),
  gated: false,
  describe: (a) => ({ action: `Sizing up ${a.dir ? name(a.dir) : "the folder"}`, reversibility: "reversible" }),
  summarize: (r) => {
    if (!r.ok) return r.summary ?? "I couldn't size up that folder.";
    const d = r.data as any;
    const big = d?.largestFiles?.[0];
    const tail = big ? `, biggest is ${name(big.path)} (${humanBytes(big.size)})` : "";
    return `Looked through ${name(d?.dir ?? "the folder")} — ${d?.totalFiles ?? 0} file(s), ${humanBytes(d?.totalBytes ?? 0)}${tail}.`;
  },
  run: async (a, ctx) => {
    try {
      const root = resolveWithin(ctx.roots, a.dir ?? ".");
      assertRealWithin(ctx.roots, root);
      const MAX_NODES = 20_000; // walk budget — stop and flag `truncated` rather than hang
      const MAX_DEPTH = 8;
      const TOP = 5;
      let nodes = 0;
      let totalBytes = 0;
      let totalFiles = 0;
      let truncated = false;
      const byExt = new Map<string, { bytes: number; count: number }>();
      const largest: { path: string; size: number }[] = [];

      const tallyFile = (full: string, fname: string): number => {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          return 0; // unreadable — skip
        }
        totalFiles++;
        totalBytes += size;
        const dot = fname.lastIndexOf(".");
        const ext = dot > 0 ? fname.slice(dot).toLowerCase() : "(no extension)";
        const e = byExt.get(ext) ?? { bytes: 0, count: 0 };
        e.bytes += size;
        e.count++;
        byExt.set(ext, e);
        largest.push({ path: full, size });
        return size;
      };

      // Returns total bytes under `dir`. Bounded by node budget + depth.
      const walk = (dir: string, depth: number): number => {
        if (truncated || depth > MAX_DEPTH) return 0;
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return 0; // unreadable folder — skip
        }
        let bytes = 0;
        for (const d of entries) {
          if (d.isDirectory() && d.name === ".errand-review") continue; // Errand's own undo store
          if (nodes >= MAX_NODES) {
            truncated = true;
            break;
          }
          nodes++;
          const full = join(dir, d.name);
          if (d.isDirectory()) bytes += walk(full, depth + 1);
          else if (d.isFile()) bytes += tallyFile(full, d.name);
        }
        return bytes;
      };

      // Top level: track each immediate sub-folder's recursive size separately.
      let top: import("node:fs").Dirent[];
      try {
        top = readdirSync(root, { withFileTypes: true });
      } catch {
        return { ok: false, error: "missing", summary: "I couldn't open that folder." };
      }
      const subfolders: { name: string; bytes: number }[] = [];
      for (const d of top) {
        if (d.isDirectory() && d.name === ".errand-review") continue; // don't count our own undo store
        if (nodes >= MAX_NODES) {
          truncated = true;
          break;
        }
        nodes++;
        const full = join(root, d.name);
        if (d.isDirectory()) subfolders.push({ name: d.name, bytes: walk(full, 1) });
        else if (d.isFile()) tallyFile(full, d.name);
      }

      largest.sort((x, y) => y.size - x.size);
      subfolders.sort((x, y) => y.bytes - x.bytes);
      const byType = [...byExt.entries()]
        .map(([ext, v]) => ({ ext, bytes: v.bytes, count: v.count }))
        .sort((x, y) => y.bytes - x.bytes)
        .slice(0, 10);

      return {
        ok: true,
        data: {
          dir: root,
          totalFiles,
          totalBytes,
          truncated,
          largestFiles: largest.slice(0, TOP),
          largestSubfolders: subfolders.slice(0, TOP),
          byType,
        },
      };
    } catch (e) {
      return fail(e);
    }
  },
};

export const fileTools = [
  listFiles,
  readFile,
  folderSummary,
  makeFolder,
  writeFile,
  moveFile,
  renameFile,
  copyFile,
  deleteFile,
];
