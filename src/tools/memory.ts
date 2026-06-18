// Memory tool — lets the agent save a durable fact about the user during a task. Benign
// (it's Errand's own note, not the user's files), so ungated. The user sees and controls
// everything via the Memory panel; dreaming later extracts the subtler patterns.
import { z } from "zod";
import type { Tool } from "./index.ts";
import { addMemory } from "../server/store.ts";

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
  gated: false,
  describe: (a) => ({ action: `Remembering that ${a.text.slice(0, 70)}`, reversibility: "reversible" }),
  summarize: () => "Noted that for next time.",
  run: async (a, ctx) => {
    await addMemory(a.text, a.kind ?? "fact", ctx.runId);
    return { ok: true };
  },
};

export const memoryTools = [remember];
