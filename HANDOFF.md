# Errand — Session Handoff (updated 2026-06-19, after the Durability + Electron + autonomous-loop session)

> Read this first to resume. Full dated detail for every item is in **`PLAN.md` §11**. The autonomous
> dev-loop queue + guardrails + done-log is in **`LOOP.md`**. This file is the short "where we are + what's next."

## What Errand is
A from-scratch TypeScript AI agent harness with a calm consumer UI for **non-technical users** — owns
every line (no LangChain / agent-SDK / reused code). Does real daily-life work: organize files (with
Undo), research the web, read & explain docs (PDF/docx/xlsx/csv + image OCR), drive the user's **real
Chrome** (via an extension) for email/web tasks, plus **MCP** tool servers, **skills**, **memory +
dreaming**. **NEW this session: it's also a macOS desktop app (Electron).**
- Stack: **Next.js 14 (App Router) + Tailwind + Geist + framer-motion**, TypeScript. SQLite via Node's
  built-in **`node:sqlite`** (no native dep) → `errand.db`. The `openai` SDK pointed at **OpenRouter
  (cloud)** or **Ollama (local/LAN)**, user-selectable per run (Settings → Model).
- Run: **`npm run web`** (Next dev, port 3200) · **`npm run app`** (Electron desktop) · `npm run cli` (CLI).
- Repo: git. **This session's work is on branch `durability-electron` — 27 commits, clean tree, NOT
  pushed and NOT merged** (the user reviews + decides). The pushed remote (`AbhiPoluri/errand`) is on the
  older `main`. `.env` / `errand.db` / caches are gitignored.

## ⚠️ FIRST, if you are an autonomous heartbeat iteration
A cron **heartbeat (`ef511639`, every 10 min, session-only)** drives the dev loop. When it fires, the
prompt tells you to `cd ~/agent-harness`, read `LOOP.md`, and run ONE iteration of its cycle (pick the
top unblocked + autonomously-safe task → plan → implement w/ tests → adversarially review → fix → keep
tsc + the 22 offline suites green (revert if not) → commit on `durability-electron` → update LOOP.md →
report). If `LOOP.md` shows a STOP banner at the top, do nothing. The heartbeat keeps firing across a
`/clear` (same process) but **dies when Claude is closed** — to resume the loop in a fresh Claude
session, re-run `/loop` or create a new heartbeat. To stop it now: `CronDelete ef511639`.

## Where we are — three arcs this session

### 1. Errand is a working macOS desktop app (Electron, macOS-first)
- `next.config` `output:'standalone'` + `scripts/prepare-standalone.mjs` (copies the static/public Next
  omits) → a self-contained server. `electron/main.cjs` forks it as a **utility process** on loopback
  **3200** (the extension's port, so the extension keeps working), opens a sandboxed BrowserWindow at it.
  `ERRAND_DATA = app.getPath('userData')` relocates all data; the OpenRouter key comes from a
  `safeStorage` keychain blob (or env) injected into the server's env only — the renderer never sees it.
  Single-instance lock; `before-quit` → kill the utility process → core `shutdown()`. `app.setName('Errand')`.
- **`npm run app`** = build + run (dev). **`npm run dist`** = electron-builder → `dist/mac-arm64/Errand.app`
  (unsigned/ad-hoc, the **'e' logo** icon, `scripts/after-pack.cjs` copies the full standalone tree +
  strips `.env`). **In-app key entry**: Settings → "OpenRouter API key" field → POST `/api/key` → main
  process encrypts via safeStorage + restarts the core. `npm run set-key` is the CLI equivalent.
- Verified: Electron 42.4.1 bundles **Node 24.16 with `node:sqlite` working**; app boots, renders the full
  UI, runs tasks; key field + GET `/api/key` work (all screenshot-verified). Commits `c5bf518`, `068b019`,
  `bf074c6`, `150b912`, `3917aad`, `88c6869`.

### 2. Durability / resumability spine (Phase 0–3, foundation COMPLETE)
- **Phase 0** (`19865b6`) — migration framework (`PRAGMA user_version` + ordered `MIGRATIONS`),
  transaction discipline (`tx()`), **seq-stability** (deltas no longer advance the durable seq → no
  silent event-skip / stuck-tab on restart), **per-run turn mutex** (`turnQueue`). 3-lens reviewed.
- **Phase 1** (`535cf95`, `ff99604`) — `src/paths.ts` (one env var `ERRAND_DATA` relocates all data),
  non-fatal API key (`hasApiKey()` + preflight), explicit `bootstrap()`/`shutdown()`.
- **Phase 3a** (`d89861f`) — `turn_state` + `tool_inflight` tables + `runs.resumable` (migration v2).
- **Phase 3b** (`a0c97b3`) — incremental mid-turn persistence: `backfillToolResults()` (always-400-safe
  snapshot), a no-op-default `checkpoint` in the loop (after-assistant + pre-approval boundaries),
  `saveTurnState/getTurnState/clearTurnState`. `resume:test`.
- **journal-before-mutate** (`a8d1cb4`) — synchronous `Journal.onRecord` hook persists the Undo manifest
  at record-time (no async gap) instead of on the later `tool.result` event.
- **Phase 3c foundation** (`d229913`) — `reconcileOrphans` clears a settled zombie's stale `turn_state`.
- **instrumentation.ts** (`88c6869`) — `register()` runs `bootstrap()` at server startup (explicit boot
  hook; module-init kept as idempotent fallback). Standalone smoke confirmed it fires before serving.
- **NOT done — the resume() ENGINE itself** (consuming `turn_state` to actually re-enter a run mid-turn).
  This is a risky core-loop refactor → tagged **needs-attended** in LOOP.md (do it WITH the user). The
  whole persistence spine it needs is built + tested.

### 3. Autonomous dev loop (`LOOP.md` + cron heartbeat)
- `LOOP.md` is the durable on-disk queue (backlog, guardrails, done-log). The loop self-drives: each
  iteration picks the top autonomously-safe task, implements + tests + reviews + commits, updates LOOP.md.
- **Lesson learned:** `ScheduleWakeup` (the `/loop` self-pace mode) is **unreliable here** — it only fires
  while the session is active/foreground, and a single missed one-shot kills the chain. The fix (the
  user's idea) is a **fixed-interval cron heartbeat** (`CronCreate`, recurring) — it self-heals (a missed
  fire doesn't end it) and fires only while idle (won't interrupt a running iteration). Heartbeat
  `ef511639` (every 10 min) is live but session-only (see the ⚠️ block above).

## Bug fixes this session (the user hit these)
- **folders** (`209a0a3`) — Errand never created its own safe-folder sandbox, so EVERY default-scoped run
  failed with "couldn't open that folder." Now auto-creates (`ensureSafeFolder`).
- **extension tab-group** (`e20f02c`, v0.2.1) — in the desktop app the UI isn't a Chrome tab, so the
  extension was hijacking the user's focused tab instead of opening its own "Errand" group. Fixed. ⚠️
  **needs an extension reload** (chrome://extensions → reload Errand, confirm v0.2.1).
- **.env-in-bundle leak** (`150b912`) — the packaged `.app` was shipping the OpenRouter key in plaintext;
  now stripped (key comes from safeStorage/launchd at runtime).

## What's next
- **Autonomous (the heartbeat / `/loop` will pick these):** Polish / adversarial-review sweep over this
  session's changes (TOP of the queue) · weak/free-model warning for browser tasks.
- **needs-attended (do WITH the user):** Phase 3c **resume() engine** (re-enter the loop mid-turn —
  could break every run if wrong) · Gmail email-row open reliability (extension change, needs a real
  logged-in browser + reload to verify).
- **needs-user:** signing + notarization (Apple Developer ID) · v8 Gmail / v9 Calendar (Google OAuth) ·
  push/merge `durability-electron` → main.

## Resume / verify quickly
- `npm run app` (desktop) or `npm run web` → http://localhost:3200. Extension loaded (green dot) for
  browser tasks. ⚠️ can't run the packaged app and `next dev` at once (both want 3200).
- **22 offline test suites** (all green): `npm run X:test` for X in: migrate seq paths folders resume loop
  web fileops journal embed store websink ext bash clickrisk restart cap endpoint zip docwrite mcp skill.
  (`mem`/`doc`/`ocr` need the OpenRouter key / are slow.) `npx tsc --noEmit` clean.
- The OpenRouter key is set (safeStorage blob at `~/Library/Application Support/Errand/openrouter.key`).

## Gotchas (will bite you)
- ⚠️ **The dock `Errand.app` is a STALE build** (predates key-entry + the durability work). Run
  `npm run dist` to repackage. (`npm run app` uses the fresh build.)
- ⚠️ **Two separate DBs by host:** `npm run web`/dev uses `~/agent-harness/errand.db`; the packaged/desktop
  app uses `~/Library/Application Support/Errand/errand.db`. The migration runs on first open (v0→2,
  verified safe on a copy of the real 56MB DB).
- ⚠️ The extension tab-group fix (v0.2.1) needs a reload to take effect.
- `node:sqlite` prints a harmless experimental warning. macOS BSD `sed` ignores `\b` (use plain substring).
- `node:sqlite` requires Node 22.5+/24 in any host — Electron 42 has it; pin future Electron accordingly.

## Source-of-truth files
- `PLAN.md` §11 — full dated changelog (every commit, with files + verification).
- `LOOP.md` — autonomous loop queue + guardrails + done log.
- `src/loop.ts` (agent loop, checkpoints), `src/server/{store,runRegistry}.ts` (persistence + lifecycle),
  `src/session.ts` (`backfillToolResults`), `src/journal.ts` (`onRecord`), `src/paths.ts` (data paths).
- `electron/main.cjs` (Electron main), `instrumentation.ts` (boot hook), `next.config.mjs`,
  `app/api/key/route.ts` (in-app key), `app/components/MemoryPanel.tsx` (Settings UI),
  `extension/{manifest.json,background.js}` (the Chrome extension, v0.2.1).
</content>
