// Memory pack — lets Errand remember a durable fact about the user during a task. Ungated
// (it's Errand's own note); retrieval into the prompt is relevance-filtered (see store.ts).
import type { Capability } from "./types.ts";
import { memoryTools } from "../tools/memory.ts";

export const memoryPack: Capability = {
  id: "memory",
  label: "Memory",
  description: "Remember small, durable facts about you so future tasks just know them.",
  tools: memoryTools,
};
