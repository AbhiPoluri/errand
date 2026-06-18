// Restart-time Undo reconstruction. The live Journal holds inverse CLOSURES that vanish when
// a run leaves memory (a server restart, or a completed run evicted from the registry). Each
// reversible op also persisted a serializable `manifest`; here we turn that manifest back into
// a real inverse so undoAll() works again after rehydration. The live path is unchanged — this
// is purely the fallback for runs that aren't in memory anymore.
import { renameSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Journal } from "../journal.ts";
import * as store from "./store.ts";

type Manifest = Record<string, any>;

// Build an inverse from a persisted op manifest, or undefined if it can't be safely reversed
// (unknown kind, missing fields, a write whose prior bytes weren't snapshotted). Returning
// undefined is the SAFE choice — the entry is then shown as non-undoable rather than running a
// guess that could destroy data. All inverses are idempotent-safe and guarded by undoAll's catch.
export function reconstructInverse(op: { manifest: unknown }): (() => Promise<void>) | undefined {
  const m = op.manifest as Manifest | null;
  if (!m || typeof m !== "object" || typeof m.kind !== "string") return undefined;
  switch (m.kind) {
    case "move": // move_file and rename_file both record this
      if (typeof m.from === "string" && typeof m.to === "string") {
        return async () => {
          if (existsSync(m.to)) renameSync(m.to, m.from);
        };
      }
      return undefined;
    case "delete": // file was parked in the Review folder; move it back
      if (typeof m.from === "string" && typeof m.dest === "string") {
        return async () => {
          if (existsSync(m.dest)) renameSync(m.dest, m.from);
        };
      }
      return undefined;
    case "copy": // remove the copy
      if (typeof m.to === "string") {
        return async () => {
          rmSync(m.to, { recursive: true, force: true });
        };
      }
      return undefined;
    case "make_folder": // remove only if still empty (never delete a folder the user filled)
      if (typeof m.path === "string") {
        return async () => {
          try {
            rmdirSync(m.path);
          } catch {
            /* user filled it — leave it */
          }
        };
      }
      return undefined;
    case "write":
      if (typeof m.path !== "string") return undefined;
      if (m.wasNew) return async () => rmSync(m.path, { force: true }); // created → delete
      if (typeof m.snapshot === "string" && m.snapshot && existsSync(m.snapshot)) {
        return async () => writeFileSync(m.path, readFileSync(m.snapshot)); // restore prior bytes
      }
      return undefined; // existed but no usable snapshot — DON'T delete the user's file
    default:
      return undefined;
  }
}

// Repopulate a freshly-rehydrated run's Journal from its persisted manifest, in original
// insertion order, so undoAll() reverses everything (in LIFO) just as the live run could. The
// original opId is preserved so re-persisting on a later turn is idempotent.
export function rebuildJournalFromStore(runId: string, journal: Journal): number {
  const ops = store.getJournalOps(runId);
  for (const op of ops) {
    journal.record({
      id: op.opId,
      op: op.op,
      description: op.description,
      reversibility: op.reversibility as any,
      manifest: op.manifest,
      inverse: reconstructInverse(op),
    });
  }
  return ops.length;
}
