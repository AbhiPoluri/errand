// Operation journal — the reversibility engine. Every mutating tool records what it
// did and HOW TO UNDO IT here. "Undo" in the UI renders ONLY for entries that recorded
// a clean inverse, so reversibility is structural, not a cosmetic label.
//
// v2 builds the engine; the real reversible file ops (move = inverse move, delete =
// move-to-Review, write = restore snapshot) are wired in v3. bash records a
// non-reversible entry (general shell can't be cleanly inverted).

import type { Reversibility } from "./tools/index.ts";

export interface JournalEntry {
  id: string;
  op: string; // "move" | "delete" | "write" | "bash" ...
  description: string; // human-language, e.g. "Moved 14 invoices into Invoices — June"
  reversibility: Reversibility; // for honest display
  ts: number;
  // Present ONLY when truly undoable. Restores the prior state; must be idempotent-safe.
  // Undo eligibility is THIS, not the label — a 'reversible' label with no inverse is a lie.
  inverse?: () => Promise<void>;
}

export class Journal {
  private entries: JournalEntry[] = [];

  record(entry: Omit<JournalEntry, "id" | "ts">): string {
    const id = crypto.randomUUID();
    // If something claims 'reversible' but recorded no inverse, demote it — never lie.
    const reversibility: Reversibility =
      entry.reversibility === "reversible" && typeof entry.inverse !== "function" ? "unknown" : entry.reversibility;
    this.entries.push({ ...entry, reversibility, id, ts: Date.now() });
    return id;
  }

  list(): readonly JournalEntry[] {
    return this.entries;
  }

  // Only entries with a real inverse are undoable.
  reversibleCount(): number {
    return this.entries.filter((e) => typeof e.inverse === "function").length;
  }

  // Undo in reverse order. Only reversible entries are touched; failures are counted,
  // never thrown (a half-failed undo must still report honestly to the user).
  async undoAll(): Promise<{ undone: number; failed: number; skipped: number }> {
    let undone = 0,
      failed = 0,
      skipped = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e.inverse) {
        skipped++;
        continue;
      }
      try {
        await e.inverse();
        undone++;
      } catch {
        failed++;
      }
    }
    return { undone, failed, skipped };
  }
}
