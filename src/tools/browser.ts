// Browser tools — drive the user's real Chrome (attached over CDP). navigate/read are
// read-only and run freely; click/type CHANGE things on real sites (could submit, send,
// buy), so they are gated and classed "unknown" (we can't model the effect, so they're
// never auto-approvable). Every action streams a fresh screenshot to the Run View.
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";
import * as browser from "../server/drive.ts";
import { classifyClickRisk } from "./clickrisk.ts";

const NOT_CONNECTED: ToolResult = {
  ok: false,
  error: "browser_not_connected",
  summary: "Your browser isn't connected yet — tap Connect my browser first.",
};

async function shoot(ctx: { onScreenshot?: (d: string) => void }): Promise<void> {
  const url = await browser.screenshot();
  if (url) ctx.onScreenshot?.(url);
}

const MAX_OBS_ELEMENTS = 50;
const MAX_OBS_TEXT = 1500;
const MAX_OBS_LABEL = 40;

// Settling: after a click/type/navigate the page often keeps changing for a moment — a dropdown
// animates open, a menu's items stream in, an AJAX panel loads. Reading it the instant the action
// returns catches that mid-transition stale view, so the model clicks the wrong (or not-yet-there)
// thing. Instead we "take our time": wait a floor for the transition to BEGIN, then poll the page
// until two consecutive reads match (it's stopped changing) — bounded so a perpetually-animating
// page can't hang us. Adaptive: a static page settles in one extra read; a slow menu waits longer.
const SETTLE_FLOOR_MS = 400; // let a just-triggered menu/transition start before the first read
const SETTLE_POLL_MS = 350; // gap between stability checks
const SETTLE_MAX_POLLS = 6; // ~2.5s ceiling on settling before we read what we have anyway
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Snap = NonNullable<Awaited<ReturnType<typeof browser.snapshot>>>;
// Two reads are "the same page" when title, count of interactive elements, and text length agree
// (a small text wobble — a ticking clock — is tolerated so it doesn't block settling forever).
function sameView(a: Snap, b: Snap): boolean {
  return a.title === b.title && a.elements.length === b.elements.length && Math.abs(a.text.length - b.text.length) < 24;
}

// Snapshot the page only once it has stopped changing.
async function settledSnapshot(): Promise<Snap | null> {
  await sleep(SETTLE_FLOOR_MS);
  let prev = await browser.snapshot();
  if (!prev) return null;
  for (let i = 0; i < SETTLE_MAX_POLLS; i++) {
    await sleep(SETTLE_POLL_MS);
    const next = await browser.snapshot();
    if (!next) return prev; // lost the read — return the last good one rather than null
    if (sameView(prev, next)) return next; // stopped changing → settled
    prev = next;
  }
  return prev; // still changing at the ceiling — read what we have
}

// After EVERY browser action, hand the model the resulting page (not just "done"). This is the
// act→observe loop: the model has to see what its click/type actually produced so it can verify
// the action did what it intended instead of assuming success. Returns null if the page can't be
// read (callers must then NOT report clean success). Sizes are budgeted to stay under the 8KB
// tool-result cap so the observation never truncates mid-JSON. Screenshot still streams to the UI.
async function observe(ctx: { onScreenshot?: (d: string) => void }) {
  // Wait for the page to settle FIRST, then read + screenshot it — so both the model's element list
  // and the UI screenshot show the finished state (menu open, content loaded), not a mid-transition.
  const snap = await settledSnapshot();
  await shoot(ctx);
  if (!snap) return null;
  browser.setLastElements(snap.elements); // keep click/type indices pointing at the CURRENT page
  return {
    title: snap.title.slice(0, 200),
    text: snap.text.length > MAX_OBS_TEXT ? snap.text.slice(0, MAX_OBS_TEXT) + "…" : snap.text,
    elements: snap.elements
      .slice(0, MAX_OBS_ELEMENTS)
      .map((e) => ({ ...e, label: (e.label ?? "").slice(0, MAX_OBS_LABEL) })),
    elementCount: snap.elements.length,
  };
}

// Build the tool result when an action's post-page couldn't be read. A clean { ok:true } here
// is the original assume-success bug — so we refuse to report success with no observation.
// A risky click might have COMMITTED something → "uncertain" (the loop tells the model not to
// retry, to verify). Everything else is safe to look-again-and-retry.
function unverified(risky: boolean): ToolResult {
  return risky
    ? {
        ok: false,
        outcome: "uncertain",
        error: "unreadable_after_action",
        summary: "I did that, but couldn't read the page afterward — since it might have done something, please check before I try again.",
      }
    : {
        ok: false,
        error: "unreadable_after_action",
        summary: "I couldn't read the page after that — let me look at it again before continuing.",
      };
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
  summarize: (r) => (r.ok ? `Opened ${(r.data as any)?.title ? `"${(r.data as any).title}"` : "the page"}.` : (r.summary ?? "I couldn't open that page.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.navigate(a.url);
      const obs = await observe(ctx);
      return obs ? { ok: true, data: { url: a.url, ...obs } } : unverified(false);
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

function elementName(index: number): { name: string; risky: boolean } {
  const info = browser.elementInfo(index);
  const label = info?.label?.trim();
  const name = label ? `"${label.slice(0, 50)}"` : info ? `the ${info.kind}` : `item ${index}`;
  return { name, risky: classifyClickRisk(info?.label, info?.kind) };
}

export const browserClick: Tool<{ index: number }> = {
  name: "browser_click",
  modelDescription:
    "Click an element by its index from browser_read. This changes the real site (it may submit, send, or buy) and can't be undone. The result is the page AFTER the click — ALWAYS check it: did the right thing actually open or change? A click can land on the wrong element or do nothing. If the page isn't what you expected, DON'T assume it worked — read it again, scroll, or try a different element before moving on.",
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
  summarize: (r) => (r.ok ? `Clicked — the page is now ${(r.data as any)?.title ? `"${(r.data as any).title}"` : "updated"}.` : (r.summary ?? "I couldn't click that.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      const { risky } = elementName(a.index); // capture risk while the index still points at this page
      await browser.clickIndex(a.index);
      // Return the resulting page so the model can VERIFY the click did what it intended. If we
      // can't read it, refuse to report success (that's the assume-it-worked bug).
      const obs = await observe(ctx);
      return obs ? { ok: true, data: obs } : unverified(risky);
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e), summary: "That item wasn't there — let me look again." };
    }
  },
};

export const browserType: Tool<{ index: number; text: string }> = {
  name: "browser_type",
  modelDescription:
    "Type text into an input field by its index from browser_read (e.g. a search box or form field). The result is the page after typing — check your text actually landed in the field before submitting.",
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
  summarize: (r) => (r.ok ? "Typed that in." : (r.summary ?? "I couldn't type there.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.typeIndex(a.index, a.text);
      const obs = await observe(ctx); // show the model the field with the text in it
      return obs ? { ok: true, data: obs } : unverified(false); // typing doesn't submit → safe to look-again
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
      const obs = await observe(ctx); // reveal what's now on screen, no separate read needed
      return obs ? { ok: true, data: obs } : unverified(false);
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

// Keys that the model can press. Enter can SUBMIT (a search/form), so it's treated as a real action
// (gates like a click); the rest just navigate/edit and run freely.
const KEYS = ["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"] as const;

export const browserKey: Tool<{ key: (typeof KEYS)[number] }> = {
  name: "browser_key",
  modelDescription:
    "Press a key on the page. Use Enter to submit a search or form you've filled, Escape to close a menu/dialog, Tab to move to the next field, or ArrowDown/ArrowUp to move through an autocomplete or list. Type into a field with browser_type first.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["key"],
    properties: { key: { type: "string", enum: [...KEYS], description: "The key to press." } },
  },
  argsSchema: z.object({ key: z.enum(KEYS) }),
  gated: false,
  describe: (a) => ({
    action: `Press ${a.key}`,
    // Enter can commit something (submit a search/form); the rest are benign navigation/editing.
    reversibility: a.key === "Enter" ? "unknown" : "reversible",
  }),
  summarize: (r) => (r.ok ? "Pressed the key." : (r.summary ?? "I couldn't press that key.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.key(a.key);
      const obs = await observe(ctx);
      return obs ? { ok: true, data: obs } : unverified(a.key === "Enter"); // Enter may have committed
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const browserHover: Tool<{ index: number }> = {
  name: "browser_hover",
  modelDescription:
    "Hover the mouse over an element by its index from browser_read — use this to reveal a menu or tooltip that only appears on mouse-over, then read the page again to see what opened.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["index"],
    properties: { index: { type: "integer", description: "Index of the element from browser_read." } },
  },
  argsSchema: z.object({ index: z.number().int().nonnegative() }),
  gated: false,
  describe: (a) => {
    const el = browser.elementInfo(a.index);
    return { action: el?.label ? `Hover over "${el.label}"` : `Hover over item ${a.index}`, reversibility: "reversible" };
  },
  summarize: (r) => (r.ok ? "Hovered — checking what appeared." : (r.summary ?? "I couldn't hover there.")),
  run: async (a, ctx): Promise<ToolResult> => {
    if (!browser.isConnected()) return NOT_CONNECTED;
    try {
      await browser.hover(a.index);
      const obs = await observe(ctx);
      return obs ? { ok: true, data: obs } : unverified(false);
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const browserTools = [browserNavigate, browserRead, browserScroll, browserClick, browserType, browserKey, browserHover];
