// MCP transport layer. An MCP server is reached over some byte stream; the client (client.ts) only
// needs send(message) + an onMessage callback, so the transport is an interface. M1 ships the stdio
// transport (spawn a local server process); HTTP/SSE can implement the same McpTransport seam later.
import { spawn, type ChildProcess } from "node:child_process";

export interface McpTransport {
  start(): Promise<void>;
  send(msg: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): void;
}

export interface StdioServerConfig {
  command: string; // executable to spawn (e.g. "npx")
  args?: string[]; // e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/some/dir"]
  env?: Record<string, string>; // extra env (merged over process.env)
  cwd?: string;
}

// MCP stdio transport: newline-delimited JSON-RPC over the child's stdin/stdout. The spec requires
// each message to be a single line with NO embedded newline, so a line splitter is a complete framer.
// Anything on stderr is the server's own logging — swallowed here (M2 can surface it as health).
export class StdioTransport implements McpTransport {
  private child: ChildProcess | null = null;
  private buf = "";
  private msgCb: ((m: any) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;

  constructor(private cfg: StdioServerConfig) {}

  start(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      cwd: this.cfg.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // tolerate a non-JSON line (some servers print banners to stdout)
        }
        this.msgCb?.(msg);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", () => {
      /* server log output — intentionally swallowed in M1 */
    });
    child.on("exit", (code) => this.closeCb?.(code ? new Error(`MCP server exited (code ${code})`) : undefined));
    child.on("error", (err) => this.closeCb?.(err as Error));

    // Resolve once the process is actually running; reject if it can't be spawned at all.
    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(e as Error));
    });
  }

  send(msg: unknown): void {
    if (!this.child) throw new Error("MCP transport not started");
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  onMessage(cb: (m: any) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.child?.kill();
    this.child = null;
  }
}
