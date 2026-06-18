// Browser tools — drive the user's real Chrome (attached over CDP). navigate/read are
// read-only and run freely; click/type CHANGE things on real sites (could submit, send,
// buy), so they are gated and classed "unknown" (we can't model the effect, so they're
// never auto-approvable). Every action streams a fresh screenshot to the Run View.
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";
import * as browser from "../server/drive.ts";

const NOT_CONNECTED: ToolResult = {
  ok: false,
  error: "browser_not_connected",
  summary: "Your browser isn't connected yet — tap Connect my browser first.",
};

async function shoot(ctx: { onScreenshot?: (d: string) => void }): Promise<void> {
  const url = await browser.screenshot();
  if (url) ctx.onScreenshot?.(url);
}

export const browserNavigate: Tool<{ url: string }> = {
  name: "browser_navigate",
  modelDescription: "Open a web page in the user's browser. Use a full https URL. Read-only.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: { url: { type: "string", description: "The page URL (https)." } },
  },
  argsSchema: z.object({ url: z.string().url() }),
  gated: false,
  describe: (a) => {
    let host = a.url;
    try {
      host = new URL(a.url).host;
    } catch {}
    return { action: `Opening ${host}`, reversibility: "reversible" };
  },
  summarize: (r) => (r.ok ? "Opened the page." : (r.summary ?? "I couldn't open that page.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.navigate(a.url);
      await shoot(ctx);
      return { ok: true, data: { url: a.url } };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const browserRead: Tool<Record<string, never>> = {
  name: "browser_read",
  modelDescription:
    "Read the current page: its title, visible text, and a numbered list of things you can click or type into. Call this before clicking or typing. Read-only.",
  jsonSchema: { type: "object", additionalProperties: false, properties: {} },
  argsSchema: z.object({}),
  gated: false,
  describe: () => ({ action: "Reading the page", reversibility: "reversible" }),
  summarize: (r) =>
    r.ok ? `Read the page (${(r.data as any)?.elements?.length ?? 0} things to interact with).` : (r.summary ?? "I couldn't read the page."),
  run: async (_a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    const snap = await browser.snapshot();
    if (!snap) return NOT_CONNECTED;
    browser.setLastElements(snap.elements); // so click/type can name themselves by label
    await shoot(ctx);
    return { ok: true, data: snap };
  },
};

// Clicks that DO something consequential on a real site — these still pause for approval.
const RISKY =
  /(^|\b)(send|delete|remove|unsubscribe|buy|purchase|pay|checkout|place order|order now|confirm|submit|publish|post|trash|deactivate|sign out|log out|report spam|discard|move to trash)(\b|$)/i;

function elementName(index: number): { name: string; risky: boolean } {
  const info = browser.elementInfo(index);
  const label = info?.label?.trim();
  const name = label ? `"${label.slice(0, 50)}"` : info ? `the ${info.kind}` : `item ${index}`;
  return { name, risky: label ? RISKY.test(label) : false };
}

export const browserClick: Tool<{ index: number }> = {
  name: "browser_click",
  modelDescription:
    "Click an element by its index from browser_read. This changes things on the real site (it may submit, send, or buy) and cannot be undone.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["index"],
    properties: { index: { type: "integer", description: "Index of the element from browser_read." } },
  },
  argsSchema: z.object({ index: z.number().int().min(0) }),
  gated: false, // benign UI clicks run autonomously; only risky ones ask (see describe)
  describe: (a) => {
    const { name, risky } = elementName(a.index);
    return {
      action: `Click ${name}`,
      consequences: risky ? "This does something real on the website and can't be undone." : undefined,
      reversibility: risky ? "unknown" : "reversible",
    };
  },
  summarize: (r) => (r.ok ? "Done." : (r.summary ?? "I couldn't click that.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.clickIndex(a.index);
      await shoot(ctx);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e), summary: "That item wasn't there — let me look again." };
    }
  },
};

export const browserType: Tool<{ index: number; text: string }> = {
  name: "browser_type",
  modelDescription:
    "Type text into an input field by its index from browser_read (e.g. a search box or form field).",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["index", "text"],
    properties: {
      index: { type: "integer", description: "Index of the field from browser_read." },
      text: { type: "string", description: "Text to type." },
    },
  },
  argsSchema: z.object({ index: z.number().int().min(0), text: z.string() }),
  gated: false, // typing is reversible/benign; the consequential bit is the later send-click
  describe: (a) => {
    const { name } = elementName(a.index);
    return { action: `Type "${a.text.slice(0, 40)}" into ${name}`, reversibility: "reversible" };
  },
  summarize: (r) => (r.ok ? "Done." : (r.summary ?? "I couldn't type there.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.typeIndex(a.index, a.text);
      await shoot(ctx);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e), summary: "That field wasn't there — let me look again." };
    }
  },
};

export const browserScroll: Tool<{ to?: "down" | "up" | "top" | "bottom"; amount?: number }> = {
  name: "browser_scroll",
  modelDescription:
    "Scroll the page to reveal more — down/up by a screenful, or all the way to the top/bottom. Use this when what you need (like an unsubscribe link in a footer) isn't on screen yet, then read the page again.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      to: { type: "string", enum: ["down", "up", "top", "bottom"], description: "Direction (default down)." },
      amount: { type: "integer", description: "Optional pixels to scroll (default ~one screen)." },
    },
  },
  argsSchema: z.object({ to: z.enum(["down", "up", "top", "bottom"]).optional(), amount: z.number().int().positive().optional() }),
  gated: false,
  describe: (a) => ({ action: `Scrolling ${a.to ?? "down"} the page`, reversibility: "reversible" }),
  summarize: (r) => (r.ok ? "Scrolled the page." : (r.summary ?? "I couldn't scroll.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.scroll(a.to ?? "down", a.amount);
      await shoot(ctx);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const browserTools = [browserNavigate, browserRead, browserScroll, browserClick, browserType];
