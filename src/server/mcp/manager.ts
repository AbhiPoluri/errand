// The live MCP layer: keeps a persistent connection to each enabled server, caches its mapped tools,
// and reconciles those connections to the saved config. runRegistry appends getTools() to every run's
// registry, so MCP tools flow through the normal gating/approval path. A server that's down or crashes
// simply contributes no tools — it never blocks a run or throws.
import { McpClient } from "./client.ts";
import { mcpToolsToErrandTools, type McpToolData } from "./pack.ts";
import type { McpServerConfig } from "./config.ts";
import type { Tool } from "../../tools/index.ts";

const CONNECT_TIMEOUT_MS = 15_000;

export interface McpServerStatus {
  id: string;
  label: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface Conn {
  config: McpServerConfig;
  client: McpClient | null;
  tools: Tool<Record<string, unknown>, McpToolData>[];
  connected: boolean;
  error?: string;
}

function sameSpawn(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.command === b.command &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
  );
}

export class McpManager {
  private conns = new Map<string, Conn>();
  // configure() mutates the shared `conns` map across awaits, so two overlapping reconciles (boot
  // warm-up vs a Settings POST, or two rapid toggles) could double-spawn or strand child processes.
  // Serialize them through a promise chain so each reconcile runs start-to-finish before the next.
  private queue: Promise<void> = Promise.resolve();

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => ({
      id: c.config.id,
      label: c.config.label,
      enabled: c.config.enabled,
      connected: c.connected,
      toolCount: c.tools.length,
      error: c.error,
    }));
  }

  // All tools from currently-connected, enabled servers (synchronous — read from cache).
  getTools(): Tool<Record<string, unknown>, McpToolData>[] {
    const out: Tool<Record<string, unknown>, McpToolData>[] = [];
    for (const c of this.conns.values()) if (c.config.enabled && c.connected) out.push(...c.tools);
    return out;
  }

  // Reconcile live connections to the desired config: drop removed/disabled, (re)connect new/changed.
  // Never throws — a server that won't connect just gets an error status. Serialized via `queue` so
  // overlapping calls can't interleave their map mutations.
  configure(servers: McpServerConfig[]): Promise<void> {
    const run = this.queue.catch(() => {}).then(() => this.doConfigure(servers));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doConfigure(servers: McpServerConfig[]): Promise<void> {
    const want = new Map(servers.map((s) => [s.id, s]));
    for (const [id, c] of [...this.conns]) {
      const w = want.get(id);
      if (!w || !w.enabled || !sameSpawn(c.config, w)) {
        c.client?.close();
        this.conns.delete(id);
      }
    }
    await Promise.all(servers.filter((s) => s.enabled).map((s) => this.connectOne(s)));
  }

  private async connectOne(config: McpServerConfig): Promise<void> {
    const existing = this.conns.get(config.id);
    if (existing && existing.connected) {
      existing.config = config; // already up with the same spawn (doConfigure pruned changed ones)
      return;
    }
    // Hold the client on the conn BEFORE awaiting connect, so a prune/closeAll during the connect
    // window can always kill the child (a null client would silently leak the spawned process).
    const client = McpClient.stdio({ command: config.command, args: config.args, env: config.env });
    const conn: Conn = { config, client, tools: [], connected: false };
    client.onDisconnect((err) => {
      // Server died — drop its tools and remember why; a later configure() will retry.
      conn.connected = false;
      conn.tools = [];
      conn.error = err ? String(err.message ?? err) : "server stopped";
    });
    this.conns.set(config.id, conn);
    try {
      const { tools } = await client.connect(CONNECT_TIMEOUT_MS);
      // If this entry was pruned/replaced while we were connecting, don't resurrect it — kill the
      // freshly-connected child instead of leaving it running and orphaned.
      if (this.conns.get(config.id) !== conn) {
        client.close();
        return;
      }
      conn.tools = mcpToolsToErrandTools(config.id, config.label, tools, client);
      conn.connected = true;
      conn.error = undefined;
    } catch (e) {
      client.close(); // ensure a half-spawned child is reaped on connect failure
      if (this.conns.get(config.id) === conn) {
        conn.connected = false;
        conn.tools = [];
        conn.error = String((e as any)?.message ?? e);
      }
    }
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.client?.close();
    this.conns.clear();
  }
}
