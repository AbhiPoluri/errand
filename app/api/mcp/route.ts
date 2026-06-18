// GET /api/mcp — the configured MCP servers + live status (connected / tool count / error).
// POST /api/mcp — add / remove / toggle a server. Each change re-persists the list and reconciles
// the live manager, so a new server's tools appear on the next run. Server-only (spawns processes).
import { NextRequest, NextResponse } from "next/server";
import { getMcpManager } from "../../../src/server/runRegistry.ts";
import { loadMcpServers, saveMcpServers, type McpServerConfig } from "../../../src/server/mcp/config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Merge the saved config with live status so the UI can show "connected · N tools" or an error.
function snapshot() {
  const servers = loadMcpServers();
  const status = new Map(getMcpManager().status().map((s) => [s.id, s]));
  return servers.map((s) => {
    const live = status.get(s.id);
    return {
      id: s.id,
      label: s.label,
      command: s.command,
      args: s.args ?? [],
      enabled: s.enabled,
      connected: live?.connected ?? false,
      toolCount: live?.toolCount ?? 0,
      error: live?.error,
    };
  });
}

export async function GET() {
  return NextResponse.json({ servers: snapshot() });
}

// A friendly, filesystem-safe id from a label ("My Files" -> "my-files"), unique within the list.
// Clamped to 24 chars so it can never crowd out the tool segment of the namespaced mcp__id__tool name.
function makeId(label: string, taken: Set<string>): string {
  const base = ((label || "server").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server").slice(0, 24);
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  let servers = loadMcpServers();

  if (action === "add") {
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    const command = typeof body?.command === "string" ? body.command.trim() : "";
    if (!command) return NextResponse.json({ error: "A command to run the server is required." }, { status: 400 });
    if (command.length > 200) return NextResponse.json({ error: "That command is too long." }, { status: 400 });
    const args = Array.isArray(body?.args) ? body.args.filter((a: unknown) => typeof a === "string").slice(0, 64) : [];
    const env = body?.env && typeof body.env === "object" ? body.env : undefined;
    const id = makeId(label || command, new Set(servers.map((s) => s.id)));
    const server: McpServerConfig = { id, label: label || command, command, args, env, enabled: true };
    servers = [...servers, server];
  } else if (action === "remove") {
    const id = String(body?.id ?? "");
    servers = servers.filter((s) => s.id !== id);
  } else if (action === "toggle") {
    const id = String(body?.id ?? "");
    const enabled = body?.enabled === true;
    servers = servers.map((s) => (s.id === id ? { ...s, enabled } : s));
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  saveMcpServers(servers);
  // Reconcile live connections; never throw (a server that won't connect just shows an error status).
  await getMcpManager().configure(servers).catch(() => {});
  return NextResponse.json({ servers: snapshot() });
}
