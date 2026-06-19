// Unified browser driver. Prefers the EXTENSION (the user's real browser, real logins,
// no Google block) when it's connected; otherwise falls back to the Playwright path.
// Browser tools talk to this, not to either backend directly.
import * as pw from "./browser.ts";
import * as ext from "./extension.ts";
import type { Interactive } from "./browser.ts";
import { getSetting } from "./store.ts";

// Trusted input (CDP via the extension's debugger) is on unless turned off in Settings. Sending it as
// a per-command flag keeps the extension stateless about the user's choice.
function trusted(): boolean {
  return getSetting("browserTrusted", "on") !== "off";
}

export function isConnected(): boolean {
  return ext.isExtConnected() || pw.isConnected();
}

export function usingExtension(): boolean {
  return ext.isExtConnected();
}

// Remember the last page's elements so click/type can describe themselves by LABEL
// ("Click Unsubscribe") instead of an opaque index, and judge whether to ask first.
let lastElements: { index: number; label: string; kind: string }[] = [];
export function setLastElements(els: { index: number; label: string; kind: string }[]): void {
  lastElements = els ?? [];
}
export function elementInfo(i: number): { label: string; kind: string } | null {
  return lastElements.find((e) => e.index === i) ?? null;
}

export async function navigate(url: string): Promise<void> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("navigate", { url });
    if (!r?.ok) throw new Error(r?.error ?? "couldn't open the page");
    return;
  }
  await pw.navigate(url);
}

export async function snapshot(): Promise<{ title: string; text: string; elements: Interactive[] } | null> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("read");
    if (!r?.ok) return null;
    return { title: r.title ?? "", text: r.text ?? "", elements: r.elements ?? [] };
  }
  return pw.snapshot();
}

export async function clickIndex(i: number): Promise<void> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("click", { index: i, trusted: trusted() });
    if (!r?.ok) throw new Error(r?.error ?? "couldn't click that");
    return;
  }
  await pw.clickIndex(i);
}

export async function typeIndex(i: number, text: string): Promise<void> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("type", { index: i, text });
    if (!r?.ok) throw new Error(r?.error ?? "couldn't type there");
    return;
  }
  await pw.typeIndex(i, text);
}

export async function screenshot(): Promise<string | null> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("screenshot");
    return r?.dataUrl ?? null;
  }
  return pw.screenshot();
}

export async function scroll(to: string, amount?: number): Promise<void> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("scroll", { to, amount });
    if (!r?.ok) throw new Error(r?.error ?? "couldn't scroll");
    return;
  }
  await pw.scroll(to, amount);
}

// Press a key on the focused field/page — submit a search (Enter), close a menu/dialog (Escape),
// move between fields (Tab), navigate an autocomplete (ArrowDown/Up).
export async function key(k: string): Promise<void> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("key", { key: k, trusted: trusted() });
    if (!r?.ok) throw new Error(r?.error ?? "couldn't press that key");
    return;
  }
  await pw.pressKey(k);
}

// Hover an element by index — reveals menus/tooltips that only appear on mouse-over.
export async function hover(i: number): Promise<void> {
  if (ext.isExtConnected()) {
    const r = await ext.sendCommand("hover", { index: i, trusted: trusted() });
    if (!r?.ok) throw new Error(r?.error ?? "couldn't hover there");
    return;
  }
  await pw.hoverIndex(i);
}
