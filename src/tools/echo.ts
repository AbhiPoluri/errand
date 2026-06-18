// Second harmless tool — exercises required string args + multi-tool selection.
import { z } from "zod";
import type { Tool } from "./index.ts";

const Args = z.object({ text: z.string().min(1) });
type Args = z.infer<typeof Args>;

export const echo: Tool<Args> = {
  name: "echo",
  modelDescription: "Repeat the given text back verbatim. Useful for testing the loop.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string", description: "The text to repeat back." } },
  },
  argsSchema: Args,
  gated: false,
  describe: (a) => ({
    action: `Repeating: "${a.text.length > 60 ? a.text.slice(0, 57) + "…" : a.text}"`,
    reversibility: "reversible",
  }),
  summarize: (r) => (r.ok ? "Echoed that back." : "I couldn't echo that."),
  run: async (a) => ({ ok: true, data: a.text }),
};
