// Persisted MCP server list (the `mcpServers` key in the settings KV table). One source of truth for
// which servers exist + whether each is enabled; the manager reconciles its live connections to this.
import { getSetting, setSetting } from "../store.ts";

export interface McpServerConfig {
  id: string; // stable id, used in the namespaced tool name mcp__<id>__<tool>
  label: string; // human name shown in Settings / on the approval card
  command: string; // executable to spawn (e.g. "npx")
  args?: string[]; // e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
  env?: Record<string, string>;
  enabled: boolean;
}

const KEY = "mcpServers";

export function loadMcpServers(): McpServerConfig[] {
  try {
    const raw = getSetting(KEY, "");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only well-formed entries — a corrupt row never breaks the app or the manager.
    return parsed.filter(
      (s: any) => s && typeof s.id === "string" && typeof s.command === "string" && typeof s.label === "string",
    ).map((s: any) => ({
      id: s.id,
      label: s.label,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.filter((a: unknown) => typeof a === "string") : [],
      env: s.env && typeof s.env === "object" ? s.env : undefined,
      enabled: s.enabled !== false,
    }));
  } catch {
    return [];
  }
}

export function saveMcpServers(servers: McpServerConfig[]): void {
  setSetting(KEY, JSON.stringify(servers));
}
