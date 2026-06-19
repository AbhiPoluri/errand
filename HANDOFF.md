# Errand — Session Handoff (updated 2026-06-18, after the big browser + writers + MCP/skills session)

> Read this first to resume. `PLAN.md` §11 is the full dated changelog (every item below has an
> entry there with the exact files + verification). This block is the short "where we are + what's next."

## Where we are
**Everything is on `main`, committed AND pushed to GitHub `AbhiPoluri/errand` (HEAD `4675873`, clean
tree).** The overnight branch was merged (`9d23a24`); all work since is on `main`. This session shipped
~70 commits across four arcs — each item has a dated PLAN §11 entry with files + verification:

### 1. Browser automation — the big one (it now cracks Gmail)
The session-long focus: making the agent reliably drive real sites. What it can do now, and WHY it works:
- **Reader (`extension/background.js` `readPage`)** — the agent's perception. Fixes, in order they were
  needed: overlay-first ordering (an open menu/dialog leads the element list, not buried under the
  toolbar) → shadow-DOM piercing → `role=alertdialog` + a role-less fixed-overlay fallback → surfacing
  Gmail's `[jsaction]` **div-buttons** (no ARIA role) as labelled leaves → **MODAL-ONLY**: when a real
  modal (`aria-modal`/`alertdialog`/`role=dialog` w/ a control) is open, read ONLY it (the rest is inert
  behind it — this stopped the agent clicking the page's own "Unsubscribe" LINK instead of the dialog's
  BUTTON). 80-element cap, shadow-pierced click/type targeting.
- **Settle before reading (`src/tools/browser.ts` `observe`)** — after a click, poll the page until it
  stops changing (≤~2.5s) before snapshotting, so the agent reads the OPENED menu, not a mid-transition.
- **TRUSTED input via CDP (`chrome.debugger`)** — THE fix for the hardest sites. Synthetic events are
  `isTrusted:false` and Gmail/Google ignore them; the extension now drives click/key/hover through the
  DevTools Protocol Input domain (trusted). Default-on **"Reliable clicks & keys"** toggle (Settings),
  per-command `trusted` flag from `drive.ts` (`browserTrusted` setting), synthetic fallback for iframes /
  attach-fail. Manifest gained `"debugger"` (v0.2.0).
- **Keyboard + hover tools** — `browser_key` (Enter/Escape/Tab/Arrows; Enter also `form.requestSubmit()`
  so searches submit even when keydown is intercepted) and `browser_hover`.
- **"Eyes" / vision (optional)** — feed the page SCREENSHOT to a vision model after browser actions
  (`session.pushUserImage`, latest-only prune). Default-on toggle, gated on `modelSupportsVision`.
- **PROVEN end-to-end:** with DeepSeek, the agent unsubscribed from Indeed in real Gmail (the original
  task), and passed clean Wikipedia-search + httpbin-form tests. Gmail is an outlier (jsaction buttons,
  duplicate labels, nested modals); normal sites work easily.

### 2. Binary writers — BOTH deferred writers now shipped + reviewed
- **`create_zip`** — package files into a `.zip` (`buildZip`+`crc32` in `extract.ts`; tool in `zip.ts`).
- **`save_as_document`** — WRITE `.docx`/`.xlsx` (`buildDocx`/`buildXlsx` reuse `buildZip`; tool in
  `document.ts`). Verified by round-trip through our own readers + **macOS `textutil`** opens the docx +
  `unzip -t`/`xmllint` validate the xlsx; a live agent run wrote a real Word doc.
- Both got a 3-lens adversarial review; all confirmed findings fixed (zip: FIFO/device hang, symlink
  escape; docx/xlsx: illegal-control-char corruption [the test missed it — readers are lenient], numeric
  coercion of zip-codes/IDs, content size cap). New `zip:test` + `docwrite:test`. **Deferred-writer list
  is now empty.**

### 3. MCP + Skills (`docs/MCP-SKILLS-ELECTRON-PLAN.md`)
- **MCP** — add an external tool server in Settings → "Connected tools (MCP)" and the agent gains its
  tools (gated + unknown-reversibility → always asks). `src/server/mcp/*` (stdio client + manager +
  config), `/api/mcp`. Live-verified against the real `@modelcontextprotocol/server-filesystem`.
- **Skills** — saved `SKILL.md` how-tos via `list_skills`/`use_skill`/`save_skill` (pack on by default;
  bundled `tidy-downloads`). `src/server/skills.ts` + `src/tools/skills.ts`, `/api/skills`.
- 3-lens review → 8 findings ALL fixed (notably an MCP connect-window process-leak race). New `mcp:test`
  + `skill:test`.

### 4. Models + misc
- **Configurable Ollama endpoint** — run on Ollama on another machine on the LAN (Settings → Model
  "Ollama server" URL + detected-models dropdown + reachability pre-flight). `endpoint:test`.
- Dreaming "Ideas from Errand" forced to **English** (deepseek drifted to Chinese); sun→gear settings icon.

⚠️ **Model is whatever you last picked.** This session bounced between Ollama/qwen, `nex-n2-pro:free`,
and DeepSeek. **DeepSeek or Gemini for browser tasks** — free/weak models flail (re-search instead of
clicking). Confirm in the header pill / Settings → Model before a real run.

**Suggested next (your call):**
- **Durability + Electron** — the standing big item: make runs RESUMABLE (the `SessionStore`/`RunRegistry`
  swap; restart currently reconciles to "interrupted", doesn't resume mid-flight), then wrap as a desktop
  app (agent core → Electron main process). See the MCP/skills plan doc §4. Turns it from a dev project
  into a shippable product.
- **Browser follow-ups** — Gmail email-row open reliability (the one Gmail step still finicky); a model
  picker warning for weak/free models on hard tasks; MCP HTTP/SSE transport + per-tool toggles.
- A polish/adversarial-review sweep over the session's changes.

## Resume / verify quickly
- `npm run web` → http://localhost:3200. Extension must be loaded for browser tasks (green dot on Home).
- ⚠️ **RELOAD THE EXTENSION before any browser test.** Every browser fix this session lives in
  `extension/background.js`/`manifest.json`, and the manifest is now **v0.2.0 with the `debugger`
  permission** for trusted input — so it needs chrome://extensions → Errand → reload **and accepting the
  new permission** (if reload alone doesn't take, remove + re-add unpacked `~/agent-harness/extension`).
  Trusted input shows a "Errand is debugging this browser" banner while a browser task runs (expected).
- Offline tests (all green): `npm run loop:test`, `web:test`, `fileops:test`, `journal:test`,
  `embed:test`, `store:test`, `websink:test`, `ext:test`, `bash:test`, `clickrisk:test`, `restart:test`,
  `cap:test`, `endpoint:test`, `zip:test`, `mcp:test`, `skill:test`, `docwrite:test`. (`mem:test` needs
  the OpenRouter key; `doc:test`/`ocr:test` are slower.)
- Model/endpoint switchable from the **header pill** AND Settings → Model (OpenRouter ↔ Ollama; Ollama
  can point at localhost OR a LAN machine via the "Ollama server" URL + detected-models dropdown).
  **Use DeepSeek/Gemini for browser tasks** (free/weak models flail). Settings also has **vision**
  ("Let Errand see the screen") and **trusted input** ("Reliable clicks & keys") toggles, both default-on.

## What Errand is
A from-scratch TypeScript AI agent harness with a calm consumer UI for **non-technical
users**. Built to own every line (no LangChain / agent-SDK / reused code). It does real
daily-life work: organize files (with Undo), research the web, read & explain docs, and
drive the user's **real Chrome** (via an extension) to do email/web tasks. Plus a
**memory system** and a togglable **dreaming** (reflective consolidation) feature.

- **Repo:** git, pushed to private GitHub `AbhiPoluri/errand` (`.env`/`errand.db`/caches gitignored).
- Stack: **Next.js 14 (App Router) + Tailwind + Geist + framer-motion**, TypeScript.
- Transport: the `openai` SDK pointed at **OpenRouter (cloud) OR Ollama (local / LAN)** — user-selectable
  per run (Settings → Model). Build/test default `deepseek/deepseek-v4-flash:nitro`. Embeddings + dreaming
  always use the OpenRouter singleton regardless of the chat-model choice.
- Capabilities now: organize/read/**write** files (incl. `.docx`/`.xlsx`/`.zip`), web search/read,
  drive real Chrome (trusted CDP input + optional vision), **MCP** tool servers, **skills**, memory + dreaming.
- Persistence: **SQLite via Node 24 built-in `node:sqlite`** → `errand.db` (no native dep).
- Run it: `npm run web` (port **3200**). CLI sink: `npm run cli`. Tests: `npm run v1:test` … `v3:test`, `npm run mem:test` (memory retrieval), `npm run restart:test` (orphan reconciliation), `npm run doc:test` (PDF/docx/xlsx/csv), `npm run ocr:test` (image OCR), `npm run cap:test` (capability packs).
- The Chrome extension lives in `extension/` (load unpacked; it streams over `/api/ext/*`).

## Current state (all working + verified in-browser)
v0 transport → v1 loop (UI-agnostic, AgentEvent stream, safety rails) → v2 reversibility
journal + approval pause + gated bash → v3 structured file tools w/ real Undo → v4 web
Run View over SSE → v5 real-folder scope + Undo-all + structured make_folder → web search
(DuckDuckGo, no key) → 3-state reversibility + uncertain-outcome + preflight → auto-approve
("Yes to all", reversible-only) → SQLite-persisted history (survives restart, rehydrate) →
**Chrome extension** (CDP failed; Playwright fallback exists but extension is primary:
long-lived stream keeps MV3 SW alive, tab group, no focus-steal, scroll, iframe reading,
autonomous-clicks-with-risk-gating, labelled actions) → conversation transcript + markdown +
no-task-limit (stuck-detection) → always-on composer + **interrupt/redirect** → **warm
editorial UI revamp** (paper/ink/clay/terracotta palette, `stone` neutrals, grain, diffusion
shadows; no header logo; flat working dot) → **memory + dreaming** (see below) →
**embedding-based memory retrieval** → **restart-hardening** (orphan reconciliation) →
**v6 document reading — PDF/docx/xlsx/csv + image OCR** → **v7 capability-pack architecture** →
**file attach + model switcher** → **streaming replies, copy button, delete-conversations, multi-file attach, git repo** →
**endpoint switcher (run on local Ollama or OpenRouter)** → **memory relevance-floor fix** → **browser act→observe**
(all 2026-06-17/18; see "Latest session" below + PLAN §11).

## Latest session (2026-06-18) — newest 3, plus the experience wave
1. **Endpoint switcher.** Settings → Model now also picks the **endpoint**: OpenRouter (cloud, streamed) or
   **Ollama (local, `http://localhost:11434/v1`, NON-streamed)**. Why non-streamed for local: small models emit
   tool calls as plain *text* when streamed but proper `tool_calls` when not. `client.makeClient(baseURL,apiKey)`;
   `runRegistry.currentEndpoint()/currentClient()` build a per-run client (OpenRouter singleton stays for
   embeddings/dreaming); `src/models.ts` `ENDPOINTS`; loop branches on `RunnerOpts.stream`. `/api/model` GET/POST
   carries `endpoint`. **Verified llama3.2:3b drove a tool task end-to-end.** ⚠️ The user's `errand.db` is currently
   set to **Ollama / llama3.2:3b** (from testing) — switch back via Settings → Model → OpenRouter if normal use feels off.
2. **Memory relevance-floor fix.** `rankMemories` (`store.ts`) used to inject ALL memories when ≤10 (no vector
   filter at all), so an off-topic memory ("Portland hotel deals") bled into an unrelated task and derailed the small
   model. Now cosine retrieval runs for EVERY set size + a `RELEVANCE_FLOOR=0.3` — an unrelated query injects nothing.
   (We *had* embedding retrieval since earlier this session; this removed the small-set shortcut that bypassed it.)
3. **Browser act→observe.** `browser_click` streamed a screenshot to the UI but returned "Done." to the *model* with
   no page state → it never saw misclicks and assumed success. Now every browser action returns the resulting page
   (title/text/clickable elements, size-budgeted ≤~6KB) to the model; click/type descriptions + the system prompt
   (`prompt.ts`) tell it to verify and re-read/retry. When the post-action page can't be read, tools refuse to report
   clean success — a risky click → `outcome:"uncertain"` (don't blindly re-submit). (`src/tools/browser.ts` observe()/unverified().)
   Open follow-up: the observation has no page URL (extension `read` at `extension/background.js` returns title/text/elements
   only — adding `location.href` needs an extension tweak + reload); title+content is usually enough to verify.
- Earlier this session: streaming replies, copy button, delete-conversations (single+multi-select), multi-file attach
  (Home + Run View), git repo + private GitHub. All committed + pushed.

## Memory + Dreaming (the area of active work)
- **Store** (`src/server/store.ts`): `memories` (now with an `embedding` TEXT column),
  `suggestions`, `settings` tables.
  - `addMemory(text,kind,source)` + `updateMemory(id,text)` are now **async** (embed on write,
    exact-text dedupe), `listMemories()` (no embedding col), `deleteMemory(id)`,
    `rankMemories(query,k)` / `relevantMemories(query,k)` (embedding retrieval — replaced `memoriesForPrompt()`).
  - suggestions capped at **3 newest** (`MAX_SUGGESTIONS`); `settings` is a KV table.
  - `ERRAND_DB` env var overrides the DB path (isolated tests).
- **Capture (both ways):** `remember` tool (`src/tools/memory.ts`, ungated) the agent calls
  live; plus dreaming extraction.
- **Use — DONE (2026-06-17), now embedding-based retrieval:** `buildSystemPrompt(message)`
  in `src/server/runRegistry.ts` (async) calls `relevantMemories(query)`, which embeds the
  run's first message and injects only the top-K (k=10) memories by cosine similarity. At ≤10
  memories it short-circuits to "inject all" with NO API call. See `src/server/embed.ts` and
  the §11 changelog. (Was: `memoriesForPrompt()` dumped ALL memories every run.)
- **Dreaming** (`src/server/dream.ts`): one OpenRouter chat call (json_object) over recent
  conversations + existing memories → adds durable facts, **de-duplicates via
  `duplicateGroups`** (cluster of ids + merged text; collapse each cluster to one, keep
  first id, delete rest — can't wipe a fact), emits ≤3 best suggestions. Trigger: debounced
  after each task **if enabled** (`maybeDream()` in runRegistry, 90s debounce) + manual
  "Dream now". Off by default. Guard: dreaming only deletes via its `duplicateGroups`.
- **API:** `/api/memory` (GET list + DELETE one), `/api/dream` (GET status, POST
  `{enabled}` toggle / `{now:true}` run).
- **UI:** `app/components/MemoryPanel.tsx` (gear on Home → view/forget memories + dreaming
  switch + Dream now) and an "Ideas from Errand" section on Home (`app/page.tsx`).

## >>> DONE: embedding-based memory retrieval (2026-06-17) <<<
Shipped. `memoriesForPrompt()` (full dump) → `relevantMemories(query,k)` (cosine top-K over
`openai/text-embedding-3-small`, 1536-dim). New `src/server/embed.ts`
(`embed`/`embedMany`/`cosineSimilarity`, all fail-soft → null). `store.ts`: `embedding` TEXT
column + idempotent migration; `addMemory`/`updateMemory` async, embed on write; lazy
single-flight backfill for NULL rows; `rankMemories` returns `{scored, mode}` with mode =
`all` (≤k → inject all, no API call) / `recency` (query-embed failure → newest-first) /
`semantic`. `runRegistry`: `buildSystemPrompt(message)` + `startRun` async, threads the first
message into retrieval; `app/api/runs` awaits. **Verified:** `tsc` clean; `npm run mem:test`
ranks 6/6 + concurrent-backfill 2/2; migration clean on a copy of the real `errand.db`.
Full detail in PLAN.md §11. Reviewed by a 3-lens adversarial workflow (one low-sev finding,
fixed).

## >>> DONE: restart-hardening (2026-06-17) <<<
Shipped. On a dev-server restart the in-process loop + parked-approval promise die, but the DB
still says `working` → the run was a zombie (stuck "working", dead approval card, hung spinner).
New `reconcileOrphans(liveIds)` in `store.ts` runs **once per process** at boot (guarded on
`globalThis.__errandReconciled` so HMR never touches live runs): each `working` run gets its
unresolved approvals resolved → `cancelled`, a terminal `run.error/cancelled` "interrupted"
event appended (persisted, seq continues), and `status='stopped'`. Reopening replays to a calm
"interrupted — send a message to continue"; `sendMessage` now uses `getRun` so the run is
continuable (safe: session messages roll back to the last clean turn → no dangling tool_call).
**Verified:** `tsc` clean; `npm run restart:test` (12 assertions); 3-lens adversarial review →
**zero findings**. Detail in PLAN.md §11. (Deeper hosting-grade durability — resume mid-flight,
multi-worker — still wants the store/registry swap; this makes the local case graceful, not lossy.)

## >>> DONE: v6 document reading + broadening (2026-06-17) <<<
Shipped. `read_file` (read-only) now reads PDF, Word `.docx`, **Excel `.xlsx`, CSV, and text from
images via OCR** instead of refusing them. `src/tools/extract.ts`: `docKindFor()` (magic bytes),
**hand-rolled zero-dep docx + xlsx** (ZIP central-dir walk + `inflateRawSync`; WordprocessingML→text
for docx, shared-strings + cells→tab-separated table for xlsx), **`unpdf`** for PDF, **`tesseract.js`**
for image OCR (both lazy-imported + externalized in `next.config`). CSV reads on the plain-text path.
Everything fails soft → honest refusal (scanned/no-text PDF, no-text/corrupt image, too-large file).
Path scoping unchanged; 50MB on-disk guard; docx/xlsx inflate capped at 30MB (zip-bomb); xlsx columns
capped at 16384; **OCR bounded by a 45s timeout (`OCR_TIMEOUT_MS`) so read_file can NEVER hang**, with
the worker always reclaimed and tesseract's uncaught bad-image throw suppressed via `errorHandler`.
**Verified:** `tsc` clean; `npm run doc:test` (PDF/docx/xlsx/csv) + `npm run ocr:test` (image OCR, incl.
forced-timeout + fail-soft); live Next runtime. Two adversarial review rounds found + fixed several
high-sev bugs (dropped tabs, docx zip-bomb, OCR hang ×4, OCR server-crash, xlsx empty-cell, xlsx col-OOM).
Detail in PLAN.md §11. Deps added: `unpdf`, `tesseract.js`. (OCR scope = images; scanned-PDF OCR needs
page rasterization/canvas — deliberately deferred.)

## >>> DONE: file attach + model switcher (2026-06-17) <<<
Shipped. **Attach:** Home composer has a paperclip + drag-drop; `app/api/upload/route.ts` writes the
file into the safe folder (`config.workspaceRoot`) — basename-sanitized, non-clobbering, 50MB cap,
**atomic `O_NOFOLLOW`+`O_EXCL`** (a symlink at the dest can't escape the sandbox). UI shows an attached
chip, scopes to the safe folder, and prefills "Read `<name>`…". **Run View has the same attach**
(mid-conversation): it passes `runId` so the file lands in that run's working folder (roots[0]). **Model switcher:** the gear panel
(`MemoryPanel.tsx`, now "Settings") has a **Model** section — preset dropdown + free-text OpenRouter id,
persisted via `app/api/model/route.ts` into the `settings` table; `runRegistry.currentModel()` reads it
per run (presets in `src/models.ts`). **Verified:** `tsc` clean; upload traversal/symlink/non-clobber/size
tested; drop→chip→prefill + Settings model panel screenshotted live (desktop + 375px); `/api/model` round-trip.
2-lens adversarial review of the upload → 2 findings fixed (symlink escape; chip-vs-scope mismatch). PLAN §11.

## >>> DONE: v7 capability-pack architecture (2026-06-17) <<<
Shipped. The registry is now assembled from capability packs instead of hand-wired. New
`src/capabilities/`: `types.ts` (the `Capability` contract), one file per domain
(`files`/`web`/`browser`/`memory`) wrapping its tool group + metadata + optional `requiresEnv`,
and `index.ts` with `CAPABILITIES`, `DEFAULT_PACKS`, `isAvailable()`, **`buildRegistryFor(packIds, caps?)`**
(base getDate always on; a pack missing its env is skipped, never half-wired). `runRegistry.buildRegistry()`
= `buildRegistryFor(DEFAULT_PACKS)`. **Adding v8 Gmail = one pack file (`requiresEnv: ["…OAUTH…"]`) + one
`CAPABILITIES` entry** — it appears only once authed. **Verified:** `tsc` clean; `npm run cap:test`
(19 assertions, incl. requiresEnv gating through the assembler); live Next runtime loads the chain.
3-lens adversarial review → **zero findings**. Detail in PLAN.md §11.

### Possible next tasks (from the §6b roadmap in PLAN.md — user picks)
- **v8** — Gmail read + triage + DRAFT (OAuth, read-only + gated label/archive/trash, NO send). The first OAuth pack — plugs into the v7 `requiresEnv` seam. Needs a Google Cloud project + OAuth flow (user must register/authorize).
- **v9** — Calendar read + solo self-events (rides the v8 Google grant).
- **Hosting-grade durability** — restart now reconciles gracefully (done above); the deeper swap (resume a run mid-flight, multi-worker via the `SessionStore`/`RunRegistry` seam) remains.

### Retrieval follow-ups (only if it gets used at scale)
- Tune `k` / add a similarity floor so the block isn't padded with weak matches when few are truly relevant.
- A "pinned/always-include" flag for memories that should appear regardless of the query (handoff floated this; not built — top-K covers the common case).

## How to verify the app quickly
- `npm run web`, open `localhost:3200`. Extension must be loaded (chrome://extensions →
  Load unpacked → `~/agent-harness/extension`) for browser tasks; it shows green on Home.
- Memory: ask "remember that I keep invoices in Documents/Invoices", then open the gear →
  see it; ask "where do I keep invoices?" → it answers from memory.
- Dreaming: gear → toggle on → "Dream now" → watch it add/merge/ suggest.

## Gotchas (will bite you)
- **macOS BSD `sed` ignores `\b`** — use plain substring replaces.
- **`node:sqlite`** prints an experimental warning (harmless); reused via `globalThis` across HMR.
- **MV3 service workers die when idle** — the extension keeps alive via a long-lived
  streaming `fetch("/api/ext/stream")` + a `chrome.alarms` reconnect. Don't go back to polling.
- **`playwright-core`** is in `experimental.serverComponentsExternalPackages` (Next 14 key)
  so webpack doesn't bundle it.
- Tools import `.ts` with extensions; `next.config.mjs` has a webpack `extensionAlias` for that.
- In-memory `RunRegistry`/`WebSink` lose live runs on dev-server restart (DB persists history) — now reconciled gracefully at boot (`reconcileOrphans`): zombie `working` runs become a clean interrupted state instead of hanging the UI.
- The harness loop runs server-side inside Next route handlers (`runtime = "nodejs"`); never edge.

## Source-of-truth files
- `PLAN.md` — full living spec + dated changelog (read for any detail/history).
- `src/loop.ts` — the agent loop (safety rails, approval pause, stuck-detection).
- `src/server/{store,runRegistry,dream,browser,drive,extension,webSink}.ts` — server core.
- `src/tools/*` — tools (files, extract [pdf/docx], web, browser, memory, bash, getDate, echo); `fileutil.ts` = path scope + size caps.
- `src/capabilities/*` — capability packs (`buildRegistryFor`, `DEFAULT_PACKS`, `requiresEnv` gating); add a domain = one pack file + a `CAPABILITIES` entry.
- `app/page.tsx`, `app/components/{RunView,MemoryPanel,AgentOrb}.tsx`, `app/lib/useRun.ts` — UI.
- `app/api/**` — routes (runs, ext, browser, memory, dream, folders, upload, model).
- `src/models.ts` — model presets for the in-app switcher; the chosen model persists in `settings` and is read per-run.
- `extension/{manifest.json,background.js}` — the Chrome extension.
