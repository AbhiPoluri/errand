// MCP M1 verification — the stdio client + JSON-RPC handshake + tool→Tool mapping, against a fake
// in-process MCP server (src/server/mcp/fakeServer.mjs). Asserts: handshake/serverInfo, tools/list,
// schema→Tool mapping, the gated + unknown-reversibility safety default, a tools/call round-trip,
// isError surfacing, a per-call timeout, and clean failure when the server can't start. No network.
// Run: `npm run mcp:test`.
import { join } from "node:path";
import { McpClient } from "./server/mcp/client.ts";
import type { McpTransport } from "./server/mcp/transport.ts";
import { mcpToolToErrandTool, mcpToolName } from "./server/mcp/pack.ts";
import { McpManager } from "./server/mcp/manager.ts";
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

  // --- M2: the manager reconciles connections to a config and exposes tools ---
  const mgr = new McpManager();
  await mgr.configure([{ id: "fake", label: "Fake MCP", command: process.execPath, args: [FAKE], enabled: true }]);
  check("manager reports the server connected", mgr.status()[0]?.connected === true, JSON.stringify(mgr.status()[0]));
  check("manager.getTools() exposes the 3 mapped tools", mgr.getTools().length === 3);
  check("manager tools are gated", mgr.getTools().every((t) => t.gated === true));
  // Toggling the server off removes its tools.
  await mgr.configure([{ id: "fake", label: "Fake MCP", command: process.execPath, args: [FAKE], enabled: false }]);
  check("disabled server contributes no tools", mgr.getTools().length === 0);
  check("disabled server is gone from status", mgr.status().length === 0);
  // A server that can't start yields an error status, never throws, never adds tools.
  await mgr.configure([{ id: "broken", label: "Broken", command: process.execPath, args: ["-e", "process.exit(1)"], enabled: true }]);
  check("broken server: error status, no tools, no throw", mgr.getTools().length === 0 && mgr.status()[0]?.connected === false && !!mgr.status()[0]?.error);
  mgr.closeAll();

  // --- review fix: long server ids don't collapse distinct tools to one truncated name ---
  const longId = "my-super-long-filesystem-server-for-documents-and-photos";
  const n1 = mcpToolName(longId, "read_file");
  const n2 = mcpToolName(longId, "read_directory");
  check("long-id tool names stay within 64 chars", n1.length <= 64 && n2.length <= 64, `${n1.length},${n2.length}`);
  check("long-id distinct tools keep DISTINCT names (no silent overwrite)", n1 !== n2, `${n1} vs ${n2}`);

  // --- review fix: overlapping configure() serializes (both settle, exactly one connected entry) ---
  const mgr2 = new McpManager();
  const cfgA = [{ id: "fake", label: "Fake MCP", command: process.execPath, args: [FAKE], enabled: true }];
  const settled = await Promise.allSettled([mgr2.configure(cfgA), mgr2.configure(cfgA)]);
  check("overlapping configure() both settle without throwing", settled.every((s) => s.status === "fulfilled"));
  check("overlapping configure() leaves exactly one connected server", mgr2.status().filter((s) => s.connected).length === 1, JSON.stringify(mgr2.status()));
  mgr2.closeAll();

  // --- onClose idempotency: a double-close (the over-long path reports the real reason, then the
  //     killed child's exit fires close() again with no error) must NOT overwrite the reason or
  //     double-fire onDisconnect ---
  let capturedClose: ((e?: Error) => void) | null = null;
  const fake: McpTransport = {
    start: async () => {},
    send: () => {},
    onMessage: () => {},
    onClose: (cb) => { capturedClose = cb; },
    close: () => {},
  };
  const dc = new McpClient(fake);
  let disconnects = 0;
  let lastErr: Error | undefined;
  dc.onDisconnect((e) => { disconnects++; lastErr = e; });
  const realReason = new Error("MCP server sent an over-long message (no newline)");
  capturedClose!(realReason); // 1st close: the genuine reason
  capturedClose!(undefined); // 2nd close: the killed child's exit handler
  check("double-close fires onDisconnect exactly once", disconnects === 1, `${disconnects}`);
  check("double-close keeps the FIRST (real) reason", lastErr === realReason, String(lastErr?.message));
  check("client is marked closed after close", dc.isClosed === true);
  let rejMsg = "";
  try {
    await dc.listTools(100);
  } catch (e) {
    rejMsg = String((e as Error).message);
  }
  check("a request after close rejects with the real reason (closeErr not clobbered)", /over-long message/.test(rejMsg), rejMsg);

  // --- pack.ts: contentToText flatten/truncation + the isError->uncertain safety mapping, driven by a
  //     STUB McpClient (no spawn). mcpToolToErrandTool's run() is only ever hit against the fake server's
  //     single text part above, so these branches were untested. ---
  const stubTool = (result: any) =>
    mcpToolToErrandTool("srv", "Srv", { name: "act" }, { callTool: async () => result } as unknown as McpClient);
  const textOf = async (content: any) => {
    const r = await stubTool({ content }).run({}, ctx);
    return r.ok ? (r.data as any).text : `ERR:${(r as any).error}`;
  };
  check("contentToText joins multiple text parts with newline", (await textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }])) === "a\nb");
  check("contentToText stringifies a json part", (await textOf([{ type: "json", json: { x: 1 } }])) === '{"x":1}');
  check("contentToText falls back to JSON for an unknown part type", (await textOf([{ type: "image", url: "u" }])) === JSON.stringify({ type: "image", url: "u" }));
  const trunc = await textOf([{ type: "text", text: "x".repeat(7000) }]);
  check("contentToText truncates over 6000 chars with …[truncated]", trunc.endsWith("…[truncated]") && trunc.length === 6000 + "…[truncated]".length, `${trunc.length}`);
  const errRes = await stubTool({ content: [{ type: "text", text: "server says nope" }], isError: true }).run({}, ctx);
  check("isError -> ok:false, error mcp_tool_error, outcome:uncertain (never auto-retry a maybe-committed action)", !errRes.ok && (errRes as any).error === "mcp_tool_error" && (errRes as any).outcome === "uncertain", JSON.stringify(errRes));
  check("isError surfaces the server's own text as the summary", !errRes.ok && (errRes as any).summary === "server says nope");
  const throwTool = mcpToolToErrandTool("srv", "Srv", { name: "act" }, { callTool: async () => { throw new Error("boom"); } } as unknown as McpClient);
  const thrown = await throwTool.run({}, ctx);
  check("a thrown transport error -> ok:false, outcome:uncertain", !thrown.ok && (thrown as any).outcome === "uncertain");

  // mcpToolName truncation SHAPE (collision/length already covered above; lock the hash-suffix form).
  const longName = mcpToolName("srv", "a".repeat(80));
  check("over-long tool name ends with _<6-char hash>", /_[a-z0-9]{6}$/.test(longName), longName);
  check("over-long tool name is <= 64 chars", longName.length <= 64, `${longName.length}`);
  check("mcpToolName is stable for the same (server,tool)", mcpToolName("srv", "act") === mcpToolName("srv", "act"));

  console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("mcp:test crashed:", e);
  process.exitCode = 1;
});
