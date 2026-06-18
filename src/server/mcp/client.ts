// Minimal MCP client (JSON-RPC 2.0 over a transport). Does the handshake (initialize →
// notifications/initialized → tools/list) and tools/call, with per-request timeouts, abort wiring,
// and clean rejection of all in-flight requests when the server dies. Transport-neutral (stdio in M1).
import { StdioTransport, type McpTransport, type StdioServerConfig } from "./transport.ts";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface McpContentPart {
  type: string;
  text?: string;
  [k: string]: unknown;
}
export interface McpCallResult {
  content: McpContentPart[];
  isError?: boolean;
}

const PROTOCOL_VERSION = "2024-11-05"; // widely supported; the server may negotiate a different one
const DEFAULT_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private closeErr: Error | null = null;
  serverInfo: { name?: string; version?: string } = {};

  constructor(private transport: McpTransport) {
    transport.onMessage((m) => this.onMessage(m));
    transport.onClose((err) => this.onClose(err));
  }

  static stdio(cfg: StdioServerConfig): McpClient {
    return new McpClient(new StdioTransport(cfg));
  }

  private onMessage(m: any): void {
    // Only responses (have a numeric id we issued) are routed; notifications are ignored in M1.
    if (m && typeof m.id === "number" && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error?.message ?? "MCP error"));
      else p.resolve(m.result);
    }
  }

  private onClose(err?: Error): void {
    this.closed = true;
    this.closeErr = err ?? new Error("MCP transport closed");
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.closeErr);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(this.closeErr ?? new Error("MCP client closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.transport.send({ jsonrpc: "2.0", method, params });
    } catch {
      /* a notification we couldn't send is non-fatal */
    }
  }

  // Start the process, do the handshake, and return the initial tool list.
  async connect(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ tools: McpToolDef[] }> {
    await this.transport.start();
    const init = await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "errand", version: "0.0.0" } },
      timeoutMs,
    );
    this.serverInfo = init?.serverInfo ?? {};
    this.notify("notifications/initialized");
    return { tools: await this.listTools(timeoutMs) };
  }

  async listTools(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpToolDef[]> {
    const list = await this.request("tools/list", {}, timeoutMs);
    return Array.isArray(list?.tools) ? list.tools : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<McpCallResult> {
    if (opts.signal?.aborted) throw new Error("aborted");
    const call = this.request("tools/call", { name, arguments: args ?? {} }, opts.timeoutMs);
    if (!opts.signal) return call as Promise<McpCallResult>;
    // Race the call against the caller's abort signal so a cancelled turn doesn't wait on the server.
    return Promise.race([
      call,
      new Promise<never>((_, reject) =>
        opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
    ]) as Promise<McpCallResult>;
  }

  close(): void {
    this.transport.close();
  }
}
