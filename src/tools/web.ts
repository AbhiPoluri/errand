// Web capability (no API key — DuckDuckGo HTML). Read-only, so ungated and reversible
// (nothing to undo). web_search returns result titles/links/snippets; web_fetch pulls
// a page's readable text. Both are defensive: a block or parse miss returns a calm
// "couldn't do that right now", never a crash or raw HTML.
import { z } from "zod";
import type { Tool, ToolResult } from "./index.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_CAP = 12_000;

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

export const webSearch: Tool<{ query: string }> = {
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
  summarize: (r) => (r.ok ? `Found ${(r.data as any)?.results?.length ?? 0} result(s).` : "I couldn't search just now."),
  run: async (a, ctx): Promise<ToolResult> => {
    try {
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: new URLSearchParams({ q: a.query }).toString(),
        signal: ctx.signal,
      });
      const html = await res.text();
      const results: { title: string; url: string; snippet: string }[] = [];
      // result links
      const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippets: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
      let lm: RegExpExecArray | null;
      let i = 0;
      while ((lm = linkRe.exec(html)) && results.length < 8) {
        results.push({ title: stripTags(lm[2]), url: unwrapDdg(lm[1]), snippet: snippets[i] ?? "" });
        i++;
      }
      if (results.length === 0) return { ok: false, error: "no_results", summary: "I couldn't find anything for that." };
      return { ok: true, data: { results } };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const webFetch: Tool<{ url: string }> = {
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
  run: async (a, ctx): Promise<ToolResult> => {
    try {
      const res = await fetch(a.url, { headers: { "User-Agent": UA }, signal: ctx.signal });
      if (!res.ok) return { ok: false, error: `http_${res.status}`, summary: "That page didn't load." };
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("html") && !ct.includes("text")) {
        return { ok: false, error: "not_text", summary: "That link isn't a readable web page." };
      }
      const html = await res.text();
      const text = stripTags(html).slice(0, FETCH_CAP);
      return { ok: true, data: { url: a.url, text }, bytes: html.length };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

export const webTools = [webSearch, webFetch];
