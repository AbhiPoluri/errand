// Offline test for web_search HTML parsing — no network. Feeds a captured-shape DuckDuckGo
// HTML fragment with an AD row (a result__a link with NO result__snippet) wedged between two
// real results — the exact case that made the old flat-array zip drift snippets onto the wrong
// result. Asserts each result keeps ITS OWN snippet and the ad gets "".
import { parseDdgResults } from "./tools/web.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

// A real result has a result__a (title+link) followed by a result__snippet in the same block.
const result = (uddg: string, title: string, snippet: string) => `
  <div class="result results_links results_links_deep web-result">
    <div class="result__body">
      <a class="result__a" href="/l/?uddg=${encodeURIComponent(uddg)}">${title}</a>
      <a class="result__snippet" href="/l/?uddg=${encodeURIComponent(uddg)}">${snippet}</a>
    </div>
  </div>`;

// An ad / zero-click row: a result__a with NO result__snippet sibling.
const adRow = (uddg: string, title: string) => `
  <div class="result result--ad">
    <div class="result__body">
      <a class="result__a" href="/l/?uddg=${encodeURIComponent(uddg)}">${title}</a>
    </div>
  </div>`;

const html = `<html><body>
  ${result("https://example.com/one", "Real One", "Snippet for the FIRST result.")}
  ${adRow("https://sponsored.example/ad", "An Advert")}
  ${result("https://example.com/two", "Real Two", "Snippet for the SECOND result.")}
</body></html>`;

const results = parseDdgResults(html);

console.log("\n== web_search per-block parse ==");
check("found 3 result rows (2 real + 1 ad)", results.length === 3, `got ${results.length}`);
check("result 0 title", results[0]?.title === "Real One", results[0]?.title);
check("result 0 url unwrapped from uddg", results[0]?.url === "https://example.com/one", results[0]?.url);
check("result 0 keeps its OWN snippet", results[0]?.snippet === "Snippet for the FIRST result.", results[0]?.snippet);
check("ad row (no snippet) gets empty string, not the next result's", results[1]?.snippet === "", `"${results[1]?.snippet}"`);
check("result 2 keeps its OWN snippet (no drift)", results[2]?.snippet === "Snippet for the SECOND result.", results[2]?.snippet);
check("result 2 url unwrapped", results[2]?.url === "https://example.com/two", results[2]?.url);

// Empty / junk HTML must not throw and returns no results.
check("empty html -> no results, no throw", parseDdgResults("<html></html>").length === 0);
check("cap is respected", parseDdgResults(html, 1).length === 1);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
