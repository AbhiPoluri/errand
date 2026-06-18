// Browser pack — drive the user's real Chrome (via the extension) to read and act on web
// pages: navigate, read, scroll, and the gated click/type mutations.
import type { Capability } from "./types.ts";
import { browserTools } from "../tools/browser.ts";

export const browserPack: Capability = {
  id: "browser",
  label: "Browser",
  description: "Open and read web pages in your Chrome, scroll, and — with your okay — click and type to get things done.",
  tools: browserTools,
};
