// Web capability (no API key — DuckDuckGo HTML). Read-only, so ungated and reversible
// (nothing to undo). web_search returns result titles/links/snippets; web_fetch pulls
// a page's readable text. Both are defensive: a block or parse miss returns a calm
// "couldn't do that right now", never a crash or raw HTML.
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_CAP = 12_000;
const RAW_CAP = 262_144; // 256KB — most raw bytes we'll pull off the wire before capping
const WEB_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS) || 15_000;

// A signal that aborts on the caller's cancel OR after a deadline. web_fetch/web_search run
// autonomously on arbitrary URLs; without this a host that completes the handshake then trickles
// (or never sends) the body would hang the tool until the whole run is cancelled.
export function withDeadline(signal: AbortSignal, ms = WEB_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

// Read a response body with a hard byte cap, STREAMING so a multi-GB / chunked-forever response is
// never fully buffered (res.text() would buffer it all before we slice). Cancels the reader once we
// have enough. Falls back to text() when there's no readable stream (e.g. a test fake).
export async function readCapped(
  res: { body?: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  maxBytes = RAW_CAP,
): Promise<string> {
  const body = res.body;
  if (!body || typeof (body as any).getReader !== "function") {
    return (await res.text()).slice(0, maxBytes);
  }
  const reader = body.getReader();
  // Decode incrementally (stream:true buffers a partial multibyte sequence that straddles a chunk
  // OR the cap boundary), so we never cut a UTF-8 char in half into a U+FFFD. Whole chunks only.
  const dec = new TextDecoder("utf-8");
  let out = "";
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        out += dec.decode(value, { stream: true });
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  out += dec.decode(); // flush any trailing buffered bytes
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// DuckDuckGo wraps result links as /l/?uddg=<encoded-real-url>; unwrap it.
function unwrapDdg(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Parse DDG HTML result-by-result. Each result__a (title+link) is paired with the
// result__snippet that falls in ITS block — between this link and the next — rather than
// zipping two flat arrays by index. The flat zip drifts the moment a row (an ad, a zero-click
// answer, a "related") has a result__a with no matching result__snippet, attaching the wrong
// snippet to every result after it. A result with no snippet in its block gets "".
export function parseDdgResults(html: string, cap = 8): SearchResult[] {
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: { pos: number; url: string; title: string }[] = [];
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html))) links.push({ pos: lm.index, url: unwrapDdg(lm[1]), title: stripTags(lm[2]) });
  const snips: { pos: number; text: string }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snips.push({ pos: sm.index, text: stripTags(sm[1]) });
  const out: SearchResult[] = [];
  for (let k = 0; k < links.length && out.length < cap; k++) {
    const start = links[k].pos;
    const end = k + 1 < links.length ? links[k + 1].pos : Infinity;
    const snip = snips.find((s) => s.pos > start && s.pos < end); // snippet inside THIS result's block
    if (!links[k].title && !links[k].url) continue;
    out.push({ title: links[k].title, url: links[k].url, snippet: snip?.text ?? "" });
  }
  return out;
}

export const webSearch: Tool<{ query: string }, { results: SearchResult[] }> = {
  name: "web_search",
  modelDescription: "Search the web and get a list of result titles, links, and snippets. Read-only.",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: { query: { type: "string", description: "What to search for." } },
  },
  argsSchema: z.object({ query: z.string().min(1) }),
  gated: false,
  describe: (a) => ({ action: `Searching the web for "${a.query.slice(0, 60)}"`, reversibility: "reversible" }),
  summarize: (r) => (r.ok ? `Found ${r.data?.results?.length ?? 0} result(s).` : "I couldn't search just now."),
  run: async (a, ctx): Promise<ToolResult<{ results: SearchResult[] }>> => {
    try {
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: new URLSearchParams({ q: a.query }).toString(),
        signal: withDeadline(ctx.signal),
      });
      const html = await readCapped(res);
      const results = parseDdgResults(html);
      if (results.length === 0) return { ok: false, error: "no_results", summary: "I couldn't find anything for that." };
      return { ok: true, data: { results } };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const webFetch: Tool<{ url: string }, { url: string; text: string }> = {
  name: "web_fetch",
  modelDescription: "Open a web page and read its text content. Read-only. Give a full https URL.",
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
    return { action: `Reading the page at ${host}`, reversibility: "reversible" };
  },
  summarize: (r) => (r.ok ? "Read the page." : "I couldn't open that page."),
  run: async (a, ctx): Promise<ToolResult<{ url: string; text: string }>> => {
    try {
      const res = await fetch(a.url, { headers: { "User-Agent": UA }, signal: withDeadline(ctx.signal) });
      if (!res.ok) return { ok: false, error: `http_${res.status}`, summary: "That page didn't load." };
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("html") && !ct.includes("text")) {
        return { ok: false, error: "not_text", summary: "That link isn't a readable web page." };
      }
      const raw = await readCapped(res);
      const text = stripTags(raw).slice(0, FETCH_CAP);
      return { ok: true, data: { url: a.url, text }, bytes: raw.length };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const webTools = [webSearch, webFetch];
