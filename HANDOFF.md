# Errand — Session Handoff (updated 2026-08-28 — project WRAPPED)

> Read this first to resume. Full dated detail is in **`PLAN.md` §11**. The (now closed) autonomous
> dev-loop queue is in **`LOOP.md`**. This file is the short "where we are + what's next."

## What Errand is
A from-scratch TypeScript AI agent harness with a calm consumer UI for **non-technical users** — owns
every line (no LangChain / agent-SDK / reused code). Does real daily-life work: organize files (with
Undo), research the web, read & explain docs (PDF/docx/xlsx/csv + image OCR), drive the user's **real
Chrome** (via an extension) for email/web tasks, plus **MCP** tool servers, **skills**, **memory +
dreaming**, and a **macOS desktop app (Electron)**.
- Stack: **Next.js 14 (App Router) + Tailwind + Geist + framer-motion**, TypeScript. SQLite via Node's
  built-in **`node:sqlite`** (no native dep) → `errand.db`. The `openai` SDK pointed at **OpenRouter
  (cloud)** or **Ollama (local/LAN)**, user-selectable per run (Settings → Model).
- Run: **`npm run web`** (Next dev, port 3200) · **`npm run app`** (Electron desktop) · `npm run cli` (CLI).

## Status: WRAPPED (2026-08-28)
- `durability-electron` was **merged into `main` (fast-forward) and pushed**; the stale
  `overnight-2026-06-18` branch was deleted. Everything lives on `main`.
- **The resume() engine is DONE and default-on** (landed 2026-07-07, `6647e80` + `2e54562`) — the
  "risky core" earlier handoffs deferred. `AgentRunner.resume()` re-enters an interrupted turn from
  its SQLite checkpoint; in-flight irreversible tools are marked uncertain (never double-run);
  a pending approval is re-parked so `/decision` still resolves it. Proven by `chaos:test`
  (crash-injection at every boundary, 11/11) and live: `kill -9` the real Electron app mid-approval
  → resume in a fresh process → approve → mutate → undo, all correct. Journal undo-state survives
  restart (migration v3).
- **Health at wrap:** `npx tsc --noEmit` clean · **30 offline test suites green**: migrate seq paths
  folders resume loop web fileops journal embed store websink ext bash clickrisk restart cap endpoint
  zip docwrite mcp mcpconfig skill models userun runroute session log resumeconsumer chaos.
  (`mem`/`doc`/`ocr` need the OpenRouter key / are slow.)
- The autonomous dev loop is **closed** — no cron heartbeat is live. LOOP.md's two leftover marginal
  coverage tasks are marked won't-do (Discovery had reached exhaustion).

## What's left (all needs-user, none blocking)
- **Signing + notarization** of Errand.app — needs an Apple Developer identity.
- **v8 Gmail read+triage+draft / v9 Calendar** — needs Google OAuth set up + authorized.
- Gmail email-row open reliability in the extension — needs an attended session with a real
  logged-in browser + an extension reload to verify.

## Resume / verify quickly
- `npm run app` (desktop) or `npm run web` → http://localhost:3200. Extension loaded (green dot) for
  browser tasks. ⚠️ can't run the packaged app and `next dev` at once (both want 3200).
- Offline suite: `npm run <x>:test` for the 30 suites listed above. `npx tsc --noEmit` clean.
- The OpenRouter key is set (safeStorage blob at `~/Library/Application Support/Errand/openrouter.key`;
  dev uses `.env`).

## Gotchas (will bite you)
- ⚠️ **Two separate DBs by host:** `npm run web`/dev uses `~/agent-harness/errand.db`; the packaged/desktop
  app uses `~/Library/Application Support/Errand/errand.db`. `ERRAND_DATA` relocates everything.
- ⚠️ If the dock `Errand.app` predates the resume work, `npm run dist` repackages it.
- The extension is v0.2.1 — after changing it, reload at chrome://extensions.
- `node:sqlite` prints a harmless experimental warning; it needs Node 22.5+/24 in any host —
  Electron 42 has it; pin future Electron accordingly.
- macOS BSD `sed` ignores `\b` (use plain substring).

## Source-of-truth files
- `PLAN.md` §11 — full dated changelog (every commit, with files + verification).
- `LOOP.md` — the closed autonomous-loop queue + done log (history).
- `src/loop.ts` (agent loop, checkpoints, `resume()`), `src/server/{store,runRegistry}.ts`
  (persistence + lifecycle + `maybeResume`/`execResume`), `src/session.ts` (`backfillToolResults`),
  `src/journal.ts` (`onRecord`/`onUndone`), `src/paths.ts` (data paths).
- `electron/main.cjs` (Electron main), `instrumentation.ts` (boot hook), `next.config.mjs`,
  `app/api/key/route.ts` (in-app key), `app/components/MemoryPanel.tsx` (Settings UI),
  `extension/{manifest.json,background.js}` (the Chrome extension, v0.2.1).
