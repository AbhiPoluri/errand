// Operation journal — the reversibility engine. Every mutating tool records what it
// did and HOW TO UNDO IT here. "Undo" in the UI renders ONLY for entries that recorded
// a clean inverse, so reversibility is structural, not a cosmetic label.
//
// v2 builds the engine; the real reversible file ops (move = inverse move, delete =
// move-to-Review, write = restore snapshot) are wired in v3. bash records a
// non-reversible entry (general shell can't be cleanly inverted).

import type { Reversibility } from "./tools/index.ts";

// Serializable description of a reversible op — the source of truth for reconstructing its inverse
// after a restart (when the live closure is gone). Discriminated on `kind` so the producers (the
// file tools) and the consumer (reconstructInverse) agree at compile time and the switch is
// exhaustive: a typo like `to` instead of `dest` for a delete becomes a tsc error, not a silently
// non-undoable op.
export type OpManifest =
  | { kind: "move"; from: string; to: string } // move_file + rename_file
  | { kind: "delete"; from: string; dest: string }
  | { kind: "copy"; to: string }
  | { kind: "make_folder"; path: string }
  | { kind: "write"; path: string; wasNew: boolean; snapshot?: string | null };

export interface JournalEntry {
  id: string;
  op: string; // "move" | "delete" | "write" | "bash" ...
  description: string; // human-language, e.g. "Moved 14 invoices into Invoices — June"
  reversibility: Reversibility; // for honest display
  ts: number;
  // Present ONLY when truly undoable. Restores the prior state; must be idempotent-safe.
  // Undo eligibility is THIS, not the label — a 'reversible' label with no inverse is a lie.
  inverse?: () => Promise<void>;
  // Set true once undoAll() has successfully run this entry's inverse. An undone entry is NOT
  // reversible again (reversibleCount excludes it) and is skipped by a second undoAll — so a
  // re-created file can never be re-deleted by a stale inverse from a prior completion's "Undo all".
  undone?: boolean;
  // Serializable description of the op — persisted so the inverse can be RECONSTRUCTED after a
  // restart, when the live `inverse` closure is gone.
  manifest?: OpManifest;
}

export class Journal {
  private entries: JournalEntry[] = [];

  // Optional hook fired SYNCHRONOUSLY the instant an op is recorded — i.e. inside the tool's run(),
  // right after its mutating fs call, with NO async yield in between. The host wires this to persist
  // the manifest immediately, instead of deferring it to the later async `tool.result` event. That
  // deferral was the bug: a mutating op was durable on disk while its Undo manifest was not yet —
  // a process restart/kill in that (async) window left the change un-undoable. Recording stays AFTER
  // the successful mutation (so a failed op is never journaled), but persistence is now synchronous —
  // a restart/kill can't land between the mutation and the manifest write (no yield between them).
  // (Power-loss durability is a separate matter: WAL synchronous=NORMAL fsyncs at checkpoint, not per
  // commit — unchanged by this hook and identical to the old tool.result path.) Never breaks record().
  onRecord?: (entry: JournalEntry) => void;

  // Optional hook fired SYNCHRONOUSLY the instant undoAll() successfully reverses an entry (right
  // after `undone` is set true). The host wires this to PERSIST the undone flag, so whole-run undo
  // state survives eviction/restart. Without it, an evicted-then-rehydrated run rebuilds every entry
  // with undone=false, so a second whole-run undo would re-run inverses already applied (the
  // stale-undo re-delete risk — e.g. re-deleting a folder the user re-created). Never breaks undoAll.
  onUndone?: (entry: JournalEntry) => void;

  // `id` is normally generated; rebuildJournalFromStore passes the persisted opId so the same
  // entry re-persists idempotently (INSERT OR IGNORE) instead of duplicating on the next turn.
  // `undone` is likewise restored from the store so a rehydrated run doesn't re-undo settled ops.
  record(entry: Omit<JournalEntry, "id" | "ts"> & { id?: string }): string {
    const id = entry.id ?? crypto.randomUUID();
    // If something claims 'reversible' but recorded no inverse, demote it — never lie.
    const reversibility: Reversibility =
      entry.reversibility === "reversible" && typeof entry.inverse !== "function" ? "unknown" : entry.reversibility;
    const recorded: JournalEntry = { ...entry, reversibility, id, ts: Date.now() };
    this.entries.push(recorded);
    if (this.onRecord) {
      try {
        this.onRecord(recorded);
      } catch {
        /* persisting the manifest must never break the tool's record() call */
      }
    }
    return id;
  }

  list(): readonly JournalEntry[] {
    return this.entries;
  }

  // Only entries with a real inverse that HAVEN'T already been undone are still undoable.
  reversibleCount(): number {
    return this.entries.filter((e) => typeof e.inverse === "function" && !e.undone).length;
  }

  // Undo in reverse order. Only reversible entries are touched; failures are counted,
  // never thrown (a half-failed undo must still report honestly to the user). Already-undone
  // entries are skipped silently (a true no-op) so a SECOND undoAll — or a next completion that
  // still lists the same cumulative journal — can't re-run an inverse and, e.g., recursively
  // delete a folder the user has since re-created. A successful inverse marks the entry undone; a
  // FAILED one does not, so it stays retryable.
  async undoAll(): Promise<{ undone: number; failed: number; skipped: number }> {
    let undone = 0,
      failed = 0,
      skipped = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.undone) continue; // double-undo guard: already reversed, do nothing
      if (!e.inverse) {
        skipped++;
        continue;
      }
      try {
        await e.inverse();
        e.undone = true;
        undone++;
        if (this.onUndone) {
          try {
            this.onUndone(e);
          } catch {
            /* persisting the undone flag must never break undoAll() */
          }
        }
      } catch {
        failed++;
      }
    }
    return { undone, failed, skipped };
  }
}
