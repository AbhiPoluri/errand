// Memory tool — lets the agent save a durable fact about the user during a task. A memory is a
// DURABLE write to persistent state that carries forward into every future task, so — like any
// mutation — it is gated (pauses for the user's okay) and journaled with a real inverse (delete the
// stored memory). This closes a poisoning vector: untrusted page/document text can no longer silently
// plant a durable fact; the user sees "Remembering that …" and approves, and can undo it afterward.
// The user still sees and controls everything via the Memory panel; dreaming extracts subtler
// patterns separately (that path is the user's own review, not untrusted text).
import { z } from "zod";
import type { Tool } from "./index.ts";
import { addMemory, deleteMemory } from "../server/store.ts";

const Args = z.object({
  text: z.string().min(3),
  kind: z.enum(["preference", "fact", "pattern"]).optional(),
});
type Args = z.infer<typeof Args>;

export const remember: Tool<Args> = {
  name: "remember",
  modelDescription:
    "Save ONE short, durable fact about this person to remember next time — a preference, where they keep things, or a recurring habit (e.g. 'keeps invoices in Documents/Invoices', 'likes replies kept short'). Use sparingly: only things that will matter in future tasks, never transient details of the current task.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", description: "The fact to remember, in one short sentence." },
      kind: { type: "string", enum: ["preference", "fact", "pattern"], description: "What kind of memory this is." },
    },
  },
  argsSchema: Args,
  gated: true,
  describe: (a) => ({
    action: `Remember that ${a.text.slice(0, 70)}`,
    consequences: "I'll keep this in mind for future tasks. You can undo it here or in your saved notes.",
    reversibility: "reversible",
  }),
  summarize: () => "Noted that for next time.",
  run: async (a, ctx) => {
    const id = await addMemory(a.text, a.kind ?? "fact", ctx.runId);
    // Journal a real inverse (delete the stored memory) so the reversible label is honest and the
    // fact shows up in "What changed" with a working Undo. addMemory returns "" only for empty text
    // (Zod already forbids that) — guard anyway. deleteMemory is idempotent (a no-op if already gone).
    if (id) {
      ctx.journal.record({
        op: "remember",
        description: `Remembered: ${a.text.slice(0, 70)}`,
        reversibility: "reversible",
        inverse: async () => {
          deleteMemory(id);
        },
      });
    }
    return { ok: true };
  },
};

export const memoryTools = [remember];
