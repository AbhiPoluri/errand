// Map an MCP server's tools onto Errand's Tool contract so they flow through the SAME registry,
// gating, approval UI, and Settings toggles as native tools — no loop changes. The load-bearing
// safety choice: an MCP tool declares no reversibility and offers no inverse, so it is gated +
// reversibility:"unknown" → it always pauses for approval, is never auto-approved, never claims an
// undo, and a failed call is "uncertain" (the loop must not auto-retry a maybe-committed action).
import { z } from "zod";
import type { Tool, ToolResult } from "../../tools/index.ts";
import type { McpClient, McpToolDef, McpContentPart } from "./client.ts";

// A valid, collision-free OpenAI function name: "mcp__<server>__<tool>", restricted to [A-Za-z0-9_-]
// and capped at 64 chars, so two servers can both expose "search" without clashing.
export function mcpToolName(serverId: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(serverId)}__${clean(toolName)}`.slice(0, 64);
}

const MAX_MCP_TEXT = 6_000; // keep a single result well under the 8KB tool-message cap

// Flatten the MCP content array (text / json / other) into one text payload for the model.
function contentToText(content: McpContentPart[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts = content.map((c) => {
    if (c?.type === "text" && typeof c.text === "string") return c.text;
    if (c?.type === "json" && "json" in c) return JSON.stringify((c as any).json);
    return JSON.stringify(c);
  });
  const out = parts.join("\n");
  return out.length > MAX_MCP_TEXT ? out.slice(0, MAX_MCP_TEXT) + "…[truncated]" : out;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}

export interface McpToolData {
  server: string;
  tool: string;
  text: string;
}

export function mcpToolToErrandTool(
  serverId: string,
  serverLabel: string,
  def: McpToolDef,
  client: McpClient,
): Tool<Record<string, unknown>, McpToolData> {
  // The model sees the server's own inputSchema verbatim; if a server omits it, accept a free object.
  const jsonSchema: Record<string, unknown> =
    def.inputSchema && typeof def.inputSchema === "object"
      ? def.inputSchema
      : { type: "object", properties: {}, additionalProperties: true };

  return {
    name: mcpToolName(serverId, def.name),
    modelDescription: `[${serverLabel}] ${def.description ?? def.name}`,
    jsonSchema,
    // Permissive runtime guard: the model already saw the real schema and the server validates its
    // own inputs; we only insist the args are an object (a record), not re-encode the server's schema.
    argsSchema: z.record(z.unknown()),
    gated: true, // external tool — always pause for approval
    describe: (args) => ({
      action: `Run "${def.name}" on ${serverLabel}`,
      items: Object.keys(args ?? {}).slice(0, 6),
      consequences: `This runs on the external tool server "${serverLabel}" — I can't undo it.`,
      reversibility: "unknown",
    }),
    summarize: (r) =>
      r.ok ? (r.data?.text ? oneLine(r.data.text) : `Ran "${def.name}".`) : (r.summary ?? `"${def.name}" didn't complete.`),
    run: async (args, ctx): Promise<ToolResult<McpToolData>> => {
      try {
        const res = await client.callTool(def.name, args ?? {}, { signal: ctx.signal });
        const text = contentToText(res.content);
        if (res.isError) {
          // The server ran but reported failure — surface its message; may have partially acted.
          return { ok: false, error: "mcp_tool_error", summary: text || `"${def.name}" reported an error.`, outcome: "uncertain" };
        }
        return { ok: true, data: { server: serverId, tool: def.name, text } };
      } catch (e) {
        // Transport/timeout/abort: the call may or may not have committed → uncertain, never auto-retry.
        return { ok: false, error: String((e as any)?.message ?? e), outcome: "uncertain" };
      }
    },
  };
}

// Map a whole server's tool list at once.
export function mcpToolsToErrandTools(
  serverId: string,
  serverLabel: string,
  defs: McpToolDef[],
  client: McpClient,
): Tool<Record<string, unknown>, McpToolData>[] {
  return defs.map((d) => mcpToolToErrandTool(serverId, serverLabel, d, client));
}
