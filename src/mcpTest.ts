// MCP M1 verification — the stdio client + JSON-RPC handshake + tool→Tool mapping, against a fake
// in-process MCP server (src/server/mcp/fakeServer.mjs). Asserts: handshake/serverInfo, tools/list,
// schema→Tool mapping, the gated + unknown-reversibility safety default, a tools/call round-trip,
// isError surfacing, a per-call timeout, and clean failure when the server can't start. No network.
// Run: `npm run mcp:test`.
import { join } from "node:path";
import { McpClient } from "./server/mcp/client.ts";
import { mcpToolToErrandTool, mcpToolName } from "./server/mcp/pack.ts";
import { Registry, type ToolContext } from "./tools/index.ts";
import { Journal } from "./journal.ts";

const FAKE = join(process.cwd(), "src/server/mcp/fakeServer.mjs");
let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const ctx: ToolContext = {
  signal: new AbortController().signal,
  journal: new Journal(),
  runId: "mcp-test",
  workspaceRoot: process.cwd(),
  roots: [process.cwd()],
};

async function main() {
  // --- connect + handshake ---
  const client = McpClient.stdio({ command: process.execPath, args: [FAKE] });
  const { tools } = await client.connect(5000);
  check("handshake set serverInfo.name", client.serverInfo.name === "fake-mcp", String(client.serverInfo.name));
  check("tools/list returned 3 tools", tools.length === 3, tools.map((t) => t.name).join(","));

  // --- map MCP tools → Errand Tools ---
  const errandTools = tools.map((t) => mcpToolToErrandTool("fake", "Fake MCP", t, client));
  const echo = errandTools.find((t) => t.name === mcpToolName("fake", "echo"))!;
  check("mapped name is namespaced", echo.name === "mcp__fake__echo", echo.name);
  check("mapped tool is GATED (always asks)", echo.gated === true);
  check("mapped reversibility is 'unknown' (never auto-approved/undone)", echo.describe({ message: "hi" }).reversibility === "unknown");
  check(
    "mapped jsonSchema === the server's inputSchema",
    JSON.stringify(echo.jsonSchema) === JSON.stringify(tools.find((t) => t.name === "echo")!.inputSchema),
  );
  check("modelDescription carries the server label", echo.modelDescription.startsWith("[Fake MCP]"));

  // --- registry validates the mapped tools like any native tool ---
  const reg = new Registry();
  errandTools.forEach((t) => reg.register(t));
  check("registry exposes 3 function schemas", reg.schemas().length === 3);
  check("prepare() validates a well-formed call", reg.prepare(echo.name, JSON.stringify({ message: "hi" })).ok);

  // --- tools/call round-trips ---
  const r1 = await echo.run({ message: "hello mcp" }, ctx);
  check("echo run ok + returned the text", r1.ok && r1.data?.text === "hello mcp", r1.ok ? r1.data?.text : r1.summary);
  const add = errandTools.find((t) => t.name === mcpToolName("fake", "add"))!;
  const r2 = await add.run({ a: 2, b: 3 }, ctx);
  check("add returned 5", r2.ok && r2.data?.text === "5", r2.ok ? r2.data?.text : r2.summary);

  // --- isError surfaces as a calm failure (not a throw) ---
  const r3 = await client.callTool("nope", {});
  check("unknown tool returns isError=true", r3.isError === true);

  // --- a non-responding tool times out cleanly (no hang) ---
  let timedOut = false;
  try {
    await client.callTool("hang", {}, { timeoutMs: 300 });
  } catch (e) {
    timedOut = /timed out/.test(String(e));
  }
  check("callTool times out cleanly when the server never replies", timedOut);

  client.close();

  // --- a server that can't run fails connect() cleanly (no hang/crash) ---
  const bad = McpClient.stdio({ command: process.execPath, args: ["-e", "process.exit(1)"] });
  let connectFailed = false;
  try {
    await bad.connect(2000);
  } catch {
    connectFailed = true;
  }
  check("connect() to a server that exits immediately fails cleanly", connectFailed);
  bad.close();

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("mcp:test crashed:", e);
  process.exitCode = 1;
});
