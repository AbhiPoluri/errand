// Restart-time Undo reconstruction. The live Journal holds inverse CLOSURES that vanish when
// a run leaves memory (a server restart, or a completed run evicted from the registry). Each
// reversible op also persisted a serializable `manifest`; here we turn that manifest back into
// a real inverse so undoAll() works again after rehydration. The live path is unchanged — this
// is purely the fallback for runs that aren't in memory anymore.
import { renameSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Journal, OpManifest } from "../journal.ts";
import * as store from "./store.ts";

// Build an inverse from a persisted op manifest, or undefined if it can't be safely reversed
// (no manifest, a write whose prior bytes weren't snapshotted). Returning undefined is the SAFE
// choice — the entry is then shown as non-undoable rather than running a guess that could destroy
// data. All inverses are idempotent-safe (guard both ends) and wrapped by undoAll's catch. The
// OpManifest union makes the switch exhaustive, so a new op kind won't silently fall through.
export function reconstructInverse(op: { manifest: OpManifest | null }): (() => Promise<void>) | undefined {
  const m = op.manifest;
  if (!m) return undefined;
  // The manifest came through a JSON.parse + cast (store.getJournalOps), so the OpManifest type is
  // NOT a runtime guarantee — a corrupt/partial row could be valid JSON with a known `kind` but
  // missing fields. Re-check the fields a closure depends on; if they're absent, return undefined
  // (entry shown non-undoable) rather than a closure that lies about undoability.
  switch (m.kind) {
    case "move": // move_file and rename_file both record this
      if (typeof m.from !== "string" || typeof m.to !== "string") return undefined;
      // Guard BOTH ends: only move back if the moved file is still at `to` AND nothing new has been
      // created at the original `from` — without the `!existsSync(from)`, undoing twice (or after an
      // unrelated file was recreated at `from`) would clobber it.
      return async () => {
        if (existsSync(m.to) && !existsSync(m.from)) renameSync(m.to, m.from);
      };
    case "delete": // file was parked in the Review folder; move it back
      if (typeof m.from !== "string" || typeof m.dest !== "string") return undefined;
      return async () => {
        if (existsSync(m.dest) && !existsSync(m.from)) renameSync(m.dest, m.from);
      };
    case "copy": // remove the copy
      if (typeof m.to !== "string") return undefined;
      return async () => {
        rmSync(m.to, { recursive: true, force: true });
      };
    case "make_folder": // remove only if still empty (never delete a folder the user filled)
      if (typeof m.path !== "string") return undefined;
      return async () => {
        try {
          rmdirSync(m.path);
        } catch {
          /* user filled it — leave it */
        }
      };
    case "write": {
      if (typeof m.path !== "string") return undefined;
      if (m.wasNew) return async () => rmSync(m.path, { force: true }); // created → delete
      const snap = m.snapshot;
      if (typeof snap === "string" && snap && existsSync(snap)) {
        return async () => writeFileSync(m.path, readFileSync(snap)); // restore prior bytes
      }
      return undefined; // existed but no usable snapshot — DON'T delete the user's file
    }
    default: {
      const _exhaustive: never = m; // a new OpManifest kind must be handled here
      void _exhaustive;
      return undefined;
    }
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
      manifest: op.manifest ?? undefined,
      inverse: reconstructInverse(op),
    });
  }
  return ops.length;
}
