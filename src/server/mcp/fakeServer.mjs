// A minimal stdio MCP server for tests — newline-delimited JSON-RPC 2.0. Plain ESM JS so the test
// can spawn it directly with `node` (no tsx). Tools: echo, add, and hang (never replies → timeout path).
import process from "node:process";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore non-JSON */
      }
    }
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const TOOLS = [
  { name: "echo", description: "Echo a message back", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "hang", description: "Never replies (timeout test)", inputSchema: { type: "object", properties: {} } },
];

function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" } } });
  } else if (method === "notifications/initialized") {
    // notification — no reply
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(args.message ?? "") }] } });
    } else if (name === "add") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String((args.a ?? 0) + (args.b ?? 0)) }] } });
    } else if (name === "hang") {
      // deliberately never respond
    } else {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true } });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
