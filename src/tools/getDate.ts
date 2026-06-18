// A harmless, non-gated tool to prove the loop + tool round-trip end to end.
import { z } from "zod";
import type { Tool } from "./index.ts";

const Args = z.object({
  which: z.enum(["date", "time", "datetime"]).optional(),
});
type Args = z.infer<typeof Args>;

export const getDate: Tool<Args> = {
  name: "get_date",
  modelDescription:
    "Get the current local date and/or time. Use when the user asks what day/time it is.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      which: {
        type: "string",
        enum: ["date", "time", "datetime"],
        description: "Whether to return the date, the time, or both (default both).",
      },
    },
  },
  argsSchema: Args,
  gated: false,
  describe: (a) => ({
    action:
      "Checking the current " +
      (a.which === "time" ? "time" : a.which === "date" ? "date" : "date and time"),
    reversibility: "reversible",
  }),
  summarize: (r) => (r.ok ? `It's ${String(r.data)}.` : "I couldn't read the clock."),
  run: async (a) => {
    const now = new Date();
    const which = a.which ?? "datetime";
    const out =
      which === "date"
        ? now.toLocaleDateString()
        : which === "time"
          ? now.toLocaleTimeString()
          : now.toLocaleString();
    return { ok: true, data: out };
  },
};
