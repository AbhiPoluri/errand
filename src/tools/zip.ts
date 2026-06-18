// Zip tools. extract_zip unpacks a .zip into a NEW sibling folder, reusing the proven read-only
// ZIP walk in extract.ts (so the bomb cap + central-dir parsing are shared). It is gated and
// journaled with a copy-style inverse (delete the new folder) so it's fully undoable, and every
// entry path is confined to the destination so a zip-slip ("../escape") entry can't write outside.
// create_zip is the mirror: package existing in-scope files into a new .zip via extract.ts's
// buildZip writer (round-trip-verified against this same reader), gated + journaled (inverse = delete).
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";
import { resolveWithin, assertRealWithin, exists, name, MAX_FILE_BYTES, PathError } from "./fileutil.ts";
import { listZipEntries, inflateZipEntry, buildZip } from "./extract.ts";

const MAX_ENTRIES = 5_000; // refuse pathological archives with a huge file count
const MAX_TOTAL_BYTES = 200_000_000; // 200MB unpacked budget (per-entry is capped by inflate)

export const extractZip: Tool<{ path: string }, { dest: string; files: number }> = {
  name: "extract_zip",
  modelDescription:
    "Unpack a .zip file into a new folder beside it (named after the zip). The folder is created fresh; refuses if it already exists. Undoable.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", description: "The .zip file to unpack." } },
  },
  argsSchema: z.object({ path: z.string().min(1) }),
  gated: true,
  describe: (a) => ({
    action: `Unpack ${name(a.path)} into a new folder`,
    items: [name(a.path)],
    consequences: "You can undo this.",
    reversibility: "reversible",
  }),
  summarize: (r) =>
    r.ok ? `Unpacked ${r.data?.files ?? 0} file(s) into ${name(r.data?.dest ?? "")}.` : (r.summary ?? "I couldn't unpack that."),
  run: async (a, ctx): Promise<ToolResult<{ dest: string; files: number }>> => {
    try {
      const zipPath = resolveWithin(ctx.roots, a.path);
      assertRealWithin(ctx.roots, zipPath);
      if (!exists(zipPath)) return { ok: false, error: "missing", summary: "I couldn't find that zip file." };
      if (!zipPath.toLowerCase().endsWith(".zip")) return { ok: false, error: "not_zip", summary: "That isn't a .zip file." };
      if (statSync(zipPath).size > MAX_FILE_BYTES) return { ok: false, error: "too_large", summary: "That zip is too big to open safely." };
      const buf = readFileSync(zipPath);
      const entries = listZipEntries(buf);
      if (!entries.length) return { ok: false, error: "empty", summary: "That zip looks empty or unreadable." };

      const dest = zipPath.replace(/\.zip$/i, "");
      resolveWithin(ctx.roots, dest); // the new folder must land in an allowed root
      if (exists(dest)) return { ok: false, error: "exists", summary: "A folder with that name is already there, so I left it alone." };
      mkdirSync(dest, { recursive: true });

      let written = 0;
      let total = 0;
      try {
        for (const e of entries) {
          if (e.name.endsWith("/")) continue; // directory entry — created implicitly below
          if (written >= MAX_ENTRIES) throw new Error("too_many_entries");
          // zip-slip guard: the entry must resolve INSIDE dest. A "../escape" or absolute name
          // makes resolveWithin throw — SKIP that entry (still unpack the safe ones) so a single
          // malicious path can never write outside the new folder.
          let target: string;
          try {
            target = resolveWithin([dest], e.name);
          } catch {
            continue;
          }
          const bytes = inflateZipEntry(buf, e);
          if (!bytes) continue;
          total += bytes.length;
          if (total > MAX_TOTAL_BYTES) throw new Error("unpacked_too_large");
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, bytes);
          written++;
        }
      } catch {
        rmSync(dest, { recursive: true, force: true }); // unpack failed/over-budget — leave no half-written mess
        return { ok: false, error: "unpack_failed", summary: "I couldn't finish unpacking that zip safely." };
      }

      ctx.journal.record({
        op: "copy", // a new tree at `dest`; same inverse shape as copy_file (remove it)
        description: `Unpacked ${name(zipPath)} into ${name(dest)}`,
        reversibility: "reversible",
        manifest: { kind: "copy", to: dest },
        inverse: async () => rmSync(dest, { recursive: true, force: true }),
      });
      return { ok: true, data: { dest, files: written } };
    } catch (e) {
      if (e instanceof PathError) return { ok: false, error: "path", summary: e.userSummary };
      return { ok: false, error: String((e as any)?.message ?? e) };
    }
  },
};

// The deepest ancestor of `p` that actually exists on disk — the furthest point realpathSync can
// resolve. Used to scope-check a not-yet-created output: assertRealWithin no-ops on a missing path,
// so we hand it this instead to catch a symlinked parent dir that escapes the sandbox.
function deepestExisting(p: string): string {
  let cur = p;
  while (!exists(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur; // reached the filesystem root
    cur = parent;
  }
  return cur;
}

// Give an entry a collision-free name within the archive: "notes.txt", then "notes (2).txt", …,
// so two source files that share a basename don't overwrite each other inside the zip.
function uniqueEntryName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 2;
  while (used.has(`${stem} (${i})${ext}`)) i++;
  const out = `${stem} (${i})${ext}`;
  used.add(out);
  return out;
}

export const createZip: Tool<{ files: string[]; output: string }, { output: string; files: number; bytes: number }> = {
  name: "create_zip",
  modelDescription:
    "Package one or more existing files into a NEW .zip archive (e.g. to share or email them together). Files are stored flat by their name; refuses if the output already exists. Undoable.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["files", "output"],
    properties: {
      files: { type: "array", items: { type: "string" }, minItems: 1, description: "Paths of existing files to include." },
      output: { type: "string", description: "Path for the new .zip to create (a .zip suffix is added if missing)." },
    },
  },
  argsSchema: z.object({ files: z.array(z.string().min(1)).min(1), output: z.string().min(1) }),
  gated: true,
  describe: (a) => ({
    action: `Create a zip ${name(a.output)} with ${a.files.length} file${a.files.length === 1 ? "" : "s"}`,
    items: [name(a.output)],
    consequences: "You can undo this.",
    reversibility: "reversible",
  }),
  summarize: (r) =>
    r.ok ? `Zipped ${r.data?.files ?? 0} file(s) into ${name(r.data?.output ?? "")}.` : (r.summary ?? "I couldn't create that zip."),
  run: async (a, ctx): Promise<ToolResult<{ output: string; files: number; bytes: number }>> => {
    try {
      // Output: land in an allowed root, carry a .zip suffix, and never clobber an existing file.
      let outPath = resolveWithin(ctx.roots, a.output);
      if (!outPath.toLowerCase().endsWith(".zip")) outPath = resolveWithin(ctx.roots, `${a.output}.zip`);
      // resolveWithin is purely lexical — it can't see a symlinked parent dir that points OUTSIDE
      // the root. The output doesn't exist yet (so assertRealWithin on it is a no-op), so verify the
      // deepest dir that DOES exist on the way to it: a `safe/link -> /outside` would be caught here.
      assertRealWithin(ctx.roots, deepestExisting(outPath));
      if (exists(outPath)) {
        return { ok: false, error: "exists", summary: "A file with that name is already there, so I left it alone — pick another name." };
      }

      // Read each source file inside the sandbox, enforcing the per-file + total + count caps.
      const entries: { name: string; data: Buffer }[] = [];
      const used = new Set<string>();
      const seen = new Set<string>(); // exact source paths already added — the same file listed twice is included once
      let total = 0;
      for (const f of a.files) {
        if (entries.length >= MAX_ENTRIES) return { ok: false, error: "too_many", summary: "That's too many files to zip at once." };
        const abs = resolveWithin(ctx.roots, f);
        assertRealWithin(ctx.roots, abs);
        if (seen.has(abs)) continue; // same file given twice → one entry, no junk "name (2)" duplicate
        if (!exists(abs)) return { ok: false, error: "missing", summary: `I couldn't find ${name(f)}.` };
        const st = statSync(abs);
        if (st.isDirectory()) return { ok: false, error: "is_dir", summary: `${name(f)} is a folder — give me the files inside it to zip.` };
        // Only REGULAR files. A FIFO/socket/device has no real size, so the byte caps below would be
        // meaningless and readFileSync would hang (FIFO) or read unbounded (e.g. /dev/zero → OOM).
        if (!st.isFile()) return { ok: false, error: "not_file", summary: `${name(f)} isn't a regular file I can zip.` };
        if (st.size > MAX_FILE_BYTES) return { ok: false, error: "too_large", summary: `${name(abs)} is too big to zip safely.` };
        total += st.size;
        if (total > MAX_TOTAL_BYTES) return { ok: false, error: "too_large", summary: "Those files are too large to zip together safely." };
        seen.add(abs);
        entries.push({ name: uniqueEntryName(name(abs), used), data: readFileSync(abs) });
      }

      const zip = buildZip(entries);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, zip);
      ctx.journal.record({
        op: "copy", // a brand-new file at outPath; inverse removes it (same shape as copy_file/extract_zip)
        description: `Created ${name(outPath)}`,
        reversibility: "reversible",
        manifest: { kind: "copy", to: outPath },
        inverse: async () => rmSync(outPath, { force: true }),
      });
      return { ok: true, data: { output: outPath, files: entries.length, bytes: zip.length } };
    } catch (e) {
      if (e instanceof PathError) return { ok: false, error: "path", summary: e.userSummary };
      return { ok: false, error: String((e as any)?.message ?? e) };
    }
  },
};

export const zipTools = [extractZip, createZip];
