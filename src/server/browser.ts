// Browser session manager. Drives the user's installed Chrome (channel: "chrome") with a
// dedicated PERSISTENT profile, in a visible window — so the user watches the agent work
// and logged-in sessions (Gmail etc.) persist across runs with no OAuth. Playwright
// controls it directly (reliable), rather than attaching over CDP (which hangs on system
// Chrome). A singleton on globalThis survives Next dev HMR.
import { chromium, type BrowserContext, type Page, type ElementHandle } from "playwright-core";
import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { browserProfileRoot } from "../paths.ts";

export interface Interactive {
  index: number;
  kind: string; // link | button | text | search | ...
  label: string;
}

// Chromium-based browsers Playwright can drive (channel = official, exec = launch by
// binary). Safari/Firefox can't be driven with the user's real logins, so they're absent.
interface BrowserDef {
  key: string;
  name: string;
  app: string; // macOS .app path used for detection
  channel?: string; // playwright channel for first-class browsers
  exec?: string; // executable path for other Chromium browsers
}
const BROWSERS: BrowserDef[] = [
  { key: "chrome", name: "Google Chrome", app: "/Applications/Google Chrome.app", channel: "chrome" },
  { key: "brave", name: "Brave", app: "/Applications/Brave Browser.app", exec: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
  { key: "edge", name: "Microsoft Edge", app: "/Applications/Microsoft Edge.app", channel: "msedge" },
  { key: "arc", name: "Arc", app: "/Applications/Arc.app", exec: "/Applications/Arc.app/Contents/MacOS/Arc" },
  { key: "vivaldi", name: "Vivaldi", app: "/Applications/Vivaldi.app", exec: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" },
  { key: "opera", name: "Opera", app: "/Applications/Opera.app", exec: "/Applications/Opera.app/Contents/MacOS/Opera" },
  { key: "chromium", name: "Chromium", app: "/Applications/Chromium.app", exec: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
];

export function detectBrowsers(): { key: string; name: string }[] {
  return BROWSERS.filter((b) => existsSync(b.app)).map((b) => ({ key: b.key, name: b.name }));
}

// Safari is installed on every Mac but can't be automated with the user's logins.
export function safariOnly(): boolean {
  return detectBrowsers().length === 0 && existsSync("/Applications/Safari.app");
}

interface BrowserState {
  context?: BrowserContext;
  page?: Page;
  elements?: ElementHandle[]; // handles from the last snapshot, addressed by index
  browserKey?: string;
}
const g = globalThis as unknown as { __errandBrowser?: BrowserState };
const state: BrowserState = (g.__errandBrowser ??= {});

export function isConnected(): boolean {
  return !!state.page && !state.page.isClosed();
}

export function connectedBrowser(): string | null {
  return isConnected() ? (state.browserKey ?? null) : null;
}

// Launch (or reuse) the chosen Chromium browser with a per-browser Errand profile.
export async function connect(browserKey?: string): Promise<{ connected: boolean; error?: string }> {
  if (isConnected()) return { connected: true };

  const available = BROWSERS.filter((b) => existsSync(b.app));
  if (available.length === 0) {
    const msg = safariOnly()
      ? "Errand needs a Chromium browser (Chrome, Brave, Edge, or Arc). Safari can't be automated with your logins."
      : "I couldn't find a supported browser on this computer.";
    return { connected: false, error: msg };
  }
  const pick = (browserKey && available.find((b) => b.key === browserKey)) || available[0];
  const profileDir = join(browserProfileRoot(), `.errand-${pick.key}`);

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      ...(pick.channel ? { channel: pick.channel } : { executablePath: pick.exec }),
      headless: false, // visible — the whole point is to watch
      viewport: null,
      // Don't announce automation — Google blocks sign-in on flagged browsers. (Best the
      // launch flags can do; the reliable path is signing in via openForSignIn first.)
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    state.context = context;
    state.page = page;
    state.browserKey = pick.key;
    context.on("close", () => {
      state.context = undefined;
      state.page = undefined;
      state.browserKey = undefined;
    });
    return { connected: true };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/ProcessSingleton|already (in use|running)|SingletonLock/i.test(msg)) {
      return { connected: false, error: `A ${pick.name} window for Errand is already open — close it and try again.` };
    }
    return { connected: false, error: `I couldn't open ${pick.name} on this computer.` };
  }
}

export async function disconnect(): Promise<void> {
  try {
    await state.context?.close();
  } catch {
    /* ignore */
  }
  state.context = undefined;
  state.page = undefined;
  state.browserKey = undefined;
}

// Open the SAME Errand profile as a NORMAL (non-automated) browser window, so the user
// can sign into Google (which blocks automated logins). The login persists in the
// profile, so when Errand later drives it, the user is already signed in. macOS `open`
// launches it as an ordinary app — no automation flags, nothing for Google to flag.
export async function openForSignIn(browserKey?: string): Promise<{ ok: boolean; error?: string }> {
  const available = BROWSERS.filter((b) => existsSync(b.app));
  if (available.length === 0) {
    return { ok: false, error: "No supported browser found to sign in with." };
  }
  const pick = (browserKey && available.find((b) => b.key === browserKey)) || available[0];
  const profileDir = join(browserProfileRoot(), `.errand-${pick.key}`);
  // Free the profile if Errand currently has it open under automation (single-use lock).
  if (state.browserKey === pick.key) await disconnect();
  try {
    const appName = basename(pick.app, ".app");
    spawn("open", ["-na", appName, "--args", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return { ok: true };
  } catch {
    return { ok: false, error: `I couldn't open ${pick.name} for sign-in.` };
  }
}

export function getPage(): Page | null {
  return isConnected() ? state.page! : null;
}

// JPEG data URL of the current page (streamed into the Run View so the user can watch).
export async function screenshot(): Promise<string | null> {
  const page = getPage();
  if (!page) return null;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 50 });
    return "data:image/jpeg;base64," + buf.toString("base64");
  } catch {
    return null;
  }
}

export async function navigate(url: string): Promise<void> {
  const page = getPage();
  if (!page) throw new Error("not connected");
  state.elements = undefined; // stale after navigation
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
}

// Page title + visible text + a numbered list of interactive elements the model can act
// on by index. Element handles are cached so click/type address them by index.
export async function snapshot(): Promise<{ title: string; text: string; elements: Interactive[] } | null> {
  const page = getPage();
  if (!page) return null;
  const title = await page.title().catch(() => "");
  const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 4000);
  const handles = await page
    .$$("a, button, input, textarea, select, [role=button], [role=link], [role=textbox]")
    .catch(() => [] as ElementHandle[]);
  const elements: Interactive[] = [];
  state.elements = [];
  for (const h of handles) {
    if (elements.length >= 40) break;
    const visible = await h.isVisible().catch(() => false);
    if (!visible) continue;
    const info = await (h as any)
      .evaluate((el: Element) => {
        const tag = el.tagName.toLowerCase();
        const label = (
          el.getAttribute("aria-label") ||
          (el as HTMLElement).innerText ||
          el.getAttribute("placeholder") ||
          el.getAttribute("value") ||
          el.getAttribute("name") ||
          ""
        )
          .trim()
          .slice(0, 80);
        const kind = tag === "input" ? el.getAttribute("type") || "text" : tag;
        return { kind, label };
      })
      .catch(() => null);
    if (!info) continue;
    state.elements.push(h);
    elements.push({ index: state.elements.length - 1, kind: info.kind, label: info.label });
  }
  return { title, text, elements };
}

export async function clickIndex(i: number): Promise<void> {
  const h = state.elements?.[i];
  if (!h) throw new Error("no such element — read the page again");
  await h.click({ timeout: 8000 });
}

export async function typeIndex(i: number, text: string): Promise<void> {
  const h = state.elements?.[i];
  if (!h) throw new Error("no such element — read the page again");
  await h.fill(text, { timeout: 8000 });
}

export async function pressKey(key: string): Promise<void> {
  const page = getPage();
  if (!page) throw new Error("not connected");
  await page.keyboard.press(key);
}

export async function hoverIndex(i: number): Promise<void> {
  const h = state.elements?.[i];
  if (!h) throw new Error("no such element — read the page again");
  await h.hover({ timeout: 8000 });
}

export async function scroll(to: string, amount?: number): Promise<void> {
  const page = getPage();
  if (!page) throw new Error("not connected");
  await page.evaluate(
    ({ to, amount }) => {
      const step = amount || Math.round(window.innerHeight * 0.8);
      if (to === "top") window.scrollTo({ top: 0 });
      else if (to === "bottom") window.scrollTo({ top: document.body.scrollHeight });
      else if (to === "up") window.scrollBy({ top: -step });
      else window.scrollBy({ top: step });
    },
    { to, amount: amount ?? 0 },
  );
}
