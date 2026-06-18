# Errand — MCP + Skills + Electron: design (for approval)

> Status: PROPOSAL, awaiting sign-off. Once approved, this drives the build. Nothing here is built yet.
> Grounded in the existing architecture: the `Tool<Args,Data>` contract, 3-state `reversibility`
> (reversible/permanent/unknown), the v7 capability-pack layer (`buildRegistryFor`, `requiresEnv`
> gating), the UI-agnostic loop + `EventSink`, and `runRegistry` (server-side, `runtime="nodejs"`).

## 0. TL;DR

1. **MCP first.** An MCP server is just a capability pack whose tools are discovered at runtime —
   it slots straight into the existing assembler. Build a stdio MCP client; map each MCP tool to an
   Errand `Tool` that is **gated + `reversibility:"unknown"`** (always pauses for approval, never
   auto-approved, never auto-undone). This is the "do anything" unlock without hand-coding integrations.
2. **Skills second.** A folder of named markdown procedures (Claude-Agent-Skills style) the agent
   discovers and applies. Lighter; reuses the prompt + existing tools, no new transport.
3. **Electron later.** Build MCP/skills as framework-agnostic `src/` modules (the norm already). Wrap
   in Electron once capabilities settle, paired with the durability refactor (agent core → main process).

## 1. MCP support

### 1.1 What it unlocks
Point Errand at any MCP server (filesystem, GitHub, Slack, Supabase, Playwright, a custom one…) and it
gains those tools — no per-integration code. This is the general form of what "v8 Gmail" would have been.

### 1.2 Architecture
- `src/server/mcp/client.ts` — a minimal **MCP client over stdio**: spawn `command + args + env` with
  `child_process`, speak JSON-RPC 2.0 over the process's stdin/stdout, do the handshake
  `initialize` → `notifications/initialized` → `tools/list`, and `tools/call` per invocation.
  (Transport is an interface; **stdio first**, HTTP/SSE later — same `McpTransport` seam.)
- `src/server/mcp/registry.ts` — lifecycle: connect/disconnect each configured server, cache its
  `tools/list`, surface health, restart-on-crash with backoff, hard timeouts on every call.
- `src/server/mcp/pack.ts` — `mcpToolToErrandTool(serverId, mcpTool)`: builds a `Tool` whose
  `jsonSchema` = the server's `inputSchema`, `argsSchema` = a permissive Zod pass-through (validation
  trusts the JSON schema the model already saw), and `run()` calls `tools/call` and normalizes the
  MCP content result (text/JSON) into a `ToolResult`. **`describe()` returns
  `reversibility:"unknown"`, `gated:true`**, with an `action` like `Run "<tool>" on <server>`.

### 1.3 Safety model (the load-bearing part)
MCP tools declare no reversibility and provide no inverse, so under Errand's existing rule
(the loop confirms when `tool.gated || reversibility!=="reversible"`):
- every MCP call **pauses for approval**, always;
- it is **never auto-approved** (auto-approve only ever covers `reversible`);
- it records **no journal inverse** → it never appears as undoable (we won't claim an undo we can't do);
- the approval card is **labeled "from `<server>` (external)"** so the user knows it's third-party;
- per-call **timeout + output-size cap**; a server crash fails the call calmly, never hangs the turn;
- servers are **off until the user adds one** (the pack is gated behind its config, like `requiresEnv`).

### 1.4 Capability-pack integration
Each connected server becomes a pack `mcp:<serverId>` produced at assembly time and fed through the
existing `buildRegistryFor(...)` — so MCP tools flow through the same registry, gating, and Settings
capability-toggle machinery as native tools. Zero changes to the loop.

### 1.5 Config + UI
- Persisted server list (command/args/env/enabled) — in the `settings` table (or `~/.errand-mcp.json`,
  Claude-Desktop-style). One source of truth.
- Settings → a new **"Connected tools (MCP)"** section: add/remove a server, see status
  (connected / N tools / error), enable/disable. Fail-soft: a down server shows an error, never blocks.
- `/api/mcp` GET (servers + status + tool counts) / POST (add/remove/toggle).

### 1.6 Tests
- `mcp:test` — a **fake in-process stdio MCP server** (a tiny script) the client connects to: asserts
  the handshake, `tools/list`, schema→`Tool` mapping, a `tools/call` round-trip, the unknown-reversibility
  gating default, timeout/crash fail-soft, and that a disabled/missing server is skipped by the assembler.

### 1.7 Milestones
- **M1 — client + mapping (headless):** stdio client, tool mapping, one real server (e.g.
  `@modelcontextprotocol/server-filesystem`) listed + called from a script. `mcp:test` green.
- **M2 — registry + safety + config:** lifecycle/health/restart, gated-by-default in the live loop,
  persisted config, `/api/mcp`.
- **M3 — Settings UI + adversarial review:** the "Connected tools" panel; 3-lens review
  (protocol-correctness / process-safety / gating-trust) before it's on by default.

## 2. Skills

### 2.1 Format
A `skills/` folder, one dir per skill with a `SKILL.md` (frontmatter: `name`, `description`,
`when_to_use`; body: the procedure). Mirrors Anthropic Agent Skills so they're portable.

### 2.2 Mechanism
- A `skills` capability: `list_skills` (read-only) + `use_skill(name)` which returns the skill body to
  the model, which then executes it with its **existing** tools. No new transport/process management.
- Lightweight discovery: skill `name`+`description` are summarized into the system prompt (like memory),
  so the model knows what's available and calls `use_skill` when relevant.
- A user can drop a skill into the folder; later, a "save this as a skill" affordance.

### 2.3 MCP vs skills (when each)
- **MCP** = new *capabilities* (external tools/data the agent couldn't reach before).
- **Skills** = reusable *procedures* over capabilities it already has ("tidy Downloads the way I like").
They compose: a skill can instruct the agent to use an MCP tool.

### 2.4 Tests + milestones
- `skill:test` — load a fixtures `skills/` dir, assert discovery, the prompt summary, and `use_skill`
  returning the body. **M1** read-only (list/use + prompt summary); **M2** "save as skill" affordance.

## 3. Shared shape

- **One registry, one safety vocabulary.** MCP tools and skill tools are ordinary `Tool`s assembled via
  `buildRegistryFor`; nothing in the loop, journal, or approval UI special-cases them beyond the
  external label. Reversibility stays the single safety axis (MCP ⇒ unknown; skills are just prompts).
- **One config surface.** Settings gains two sections ("Connected tools (MCP)", "Skills"), both persisted
  in `settings`, both fail-soft, both reflected in the capability toggles already there.

## 4. Electron — timing + architecture

**Recommendation: wrap later; keep new code Electron-agnostic now (already the norm).**

- The agent core (`src/`) is framework-agnostic by design; MCP child-processes spawn the same way under
  Electron's main process as under `next dev`. So MCP/skills need **zero** Electron-specific code and
  port for free.
- The only Next-coupled seam is that the loop runs *inside* route handlers with an in-memory
  `RunRegistry`/`WebSink`. The clean Electron shape — **main process** owns the loop + SQLite + MCP
  child processes, **renderer** = the current UI — is the **same work as the roadmap's "hosting-grade
  durability" item** (the `SessionStore`/`RunRegistry` swap, resume-mid-flight, multi-worker). Do it once.
- The **Chrome extension still works** under Electron (it talks to the local server over HTTP for the
  user's real logins) — Electron doesn't replace it.
- **Migration sketch (when we do it):** (a) extract the agent core behind a transport-neutral interface
  (the durability refactor); (b) Electron main process hosts it + spawns a bundled Node server or runs
  it in-process; (c) renderer loads the existing Next UI (or a thin packaged build); (d) package with
  electron-builder. Roughly a focused milestone on its own, not a rewrite.

## 5. Sequenced roadmap

1. **MCP M1–M3** (client → safety/config → Settings UI + review). The big unlock.
2. **Skills M1–M2** (read-only use → save-as-skill).
3. **Durability refactor** (the `SessionStore`/`RunRegistry` seam) — valuable on its own AND the
   prerequisite for a clean Electron host.
4. **Electron wrap** (paired with #3): main-process agent core + packaged UI.

---
**Open questions for you:**
- MCP config location — `settings` table (in-app, consistent) vs a `~/.errand-mcp.json` file
  (Claude-Desktop-familiar, hand-editable)? (I lean `settings` table.)
- Skills format — strict Anthropic `SKILL.md` parity (portable) vs a simpler Errand-native shape?
  (I lean SKILL.md parity.)
- Anything you want pulled earlier/later in §5.
