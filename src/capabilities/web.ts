// Web pack — search the web and fetch a page's readable text. No key today (DuckDuckGo);
// this is the flagship "search + fetch" pack the capability layer was proven on (PLAN §6b).
// If a paid search API is ever wired in, declare its key in requiresEnv and the pack gates
// itself automatically.
import type { Capability } from "./types.ts";
import { webTools } from "../tools/web.ts";

export const webPack: Capability = {
  id: "web",
  label: "Web",
  description: "Search the web and read the text of a page to answer questions or gather information.",
  tools: webTools,
};
