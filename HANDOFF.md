# Errand — Session Handoff (2026-06-17)

> Read this first to resume. The full living spec + changelog is in **`PLAN.md`** (same
> folder) — this file is the short "where we are + what's next" so you can start fast.

## What Errand is
A from-scratch TypeScript AI agent harness with a calm consumer UI for **non-technical
users**. Built to own every line (no LangChain / agent-SDK / reused code). It does real
daily-life work: organize files (with Undo), research the web, read & explain docs, and
drive the user's **real Chrome** (via an extension) to do email/web tasks. Plus a
**memory system** and a togglable **dreaming** (reflective consolidation) feature.

- Stack: **Next.js 14 (App Router) + Tailwind + Geist + framer-motion**, TypeScript.
- Transport: **OpenRouter** via the `openai` SDK. Model is user-selectable; build/test
  default `deepseek/deepseek-v4-flash:nitro`.
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
**v6 document reading — PDF/docx/xlsx/csv + image OCR** → **v7 capability-pack architecture** (all 2026-06-17; see DONE sections + PLAN §11).

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
