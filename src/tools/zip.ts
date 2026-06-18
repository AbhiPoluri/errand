// Zip tools. extract_zip unpacks a .zip into a NEW sibling folder, reusing the proven read-only
// ZIP walk in extract.ts (so the bomb cap + central-dir parsing are shared). It is gated and
// journaled with a copy-style inverse (delete the new folder) so it's fully undoable, and every
// entry path is confined to the destination so a zip-slip ("../escape") entry can't write outside.
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";
import { resolveWithin, assertRealWithin, exists, name, MAX_FILE_BYTES, PathError } from "./fileutil.ts";
import { listZipEntries, inflateZipEntry } from "./extract.ts";

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

export const zipTools = [extractZip];
