// Locks the MCP-server config parser/sanitizer (loadMcpServers / saveMcpServers): a corrupt settings
// row must NEVER throw or feed the manager a malformed server. Pure SQLite-KV logic, isolated
// ERRAND_DB, no network/electron. Run: `npm run mcpconfig:test`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const dbPath = join(tmpdir(), `errand-mcpconfigtest-${process.pid}.db`);
process.env.ERRAND_DB = dbPath; // MUST be set before store.ts opens the DB
const { setSetting } = await import("./server/store.ts");
const { loadMcpServers, saveMcpServers } = await import("./server/mcp/config.ts");

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const raw = (v: string) => setSetting("mcpServers", v); // inject a raw settings value

// (a) unset / empty key -> []
check("unset key -> []", loadMcpServers().length === 0);

// (b) save -> load round-trip preserves a valid server
saveMcpServers([{ id: "fs", label: "Files", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "x" }, enabled: true }]);
const rt = loadMcpServers();
check("round-trip: exactly one server", rt.length === 1, `${rt.length}`);
check("round-trip: id/label/command preserved", rt[0]?.id === "fs" && rt[0]?.label === "Files" && rt[0]?.command === "npx", JSON.stringify(rt[0]));
check("round-trip: args preserved", JSON.stringify(rt[0]?.args) === JSON.stringify(["-y", "pkg"]));
check("round-trip: env preserved", rt[0]?.env?.TOKEN === "x");

// (c) malformed JSON -> [] (no throw)
raw("{not json");
check("malformed JSON -> [] (no throw)", loadMcpServers().length === 0);

// (d) non-array JSON -> []
raw("{}");
check("object JSON -> []", loadMcpServers().length === 0);
raw('"a string"');
check("string JSON -> []", loadMcpServers().length === 0);

// (e) entries missing id/command/label (or non-objects) are dropped, valid kept
raw(JSON.stringify([
  { id: "ok", label: "OK", command: "npx" },
  { label: "no-id", command: "npx" },
  { id: "no-cmd", label: "x" },
  { id: 7, label: "num-id", command: "npx" },
  null,
  "garbage",
]));
const filtered = loadMcpServers();
check("malformed entries dropped, valid kept", filtered.length === 1 && filtered[0]?.id === "ok", JSON.stringify(filtered.map((s) => s.id)));

// (f) args coerced to string-only; missing / non-array args -> []
raw(JSON.stringify([{ id: "a", label: "A", command: "c", args: ["x", 1, null, "y", {}] }]));
check("args filtered to strings only", JSON.stringify(loadMcpServers()[0]?.args) === JSON.stringify(["x", "y"]));
raw(JSON.stringify([{ id: "a", label: "A", command: "c" }]));
check("missing args -> []", JSON.stringify(loadMcpServers()[0]?.args) === JSON.stringify([]));
raw(JSON.stringify([{ id: "a", label: "A", command: "c", args: "notarray" }]));
check("non-array args -> []", JSON.stringify(loadMcpServers()[0]?.args) === JSON.stringify([]));

// (g) env kept only when an object
raw(JSON.stringify([{ id: "a", label: "A", command: "c", env: "nope" }]));
check("non-object env -> undefined", loadMcpServers()[0]?.env === undefined);
raw(JSON.stringify([{ id: "a", label: "A", command: "c", env: { K: "v" } }]));
check("object env kept", loadMcpServers()[0]?.env?.K === "v");

// (h) enabled defaults true; only an explicit false disables (enabled !== false)
raw(JSON.stringify([{ id: "a", label: "A", command: "c" }]));
check("enabled defaults true when absent", loadMcpServers()[0]?.enabled === true);
raw(JSON.stringify([{ id: "a", label: "A", command: "c", enabled: false }]));
check("enabled:false disables", loadMcpServers()[0]?.enabled === false);
raw(JSON.stringify([{ id: "a", label: "A", command: "c", enabled: 0 }]));
check("enabled:0 (falsy, not false) stays enabled", loadMcpServers()[0]?.enabled === true);

rmSync(dbPath, { force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
