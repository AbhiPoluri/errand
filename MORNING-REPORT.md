# Errand — Overnight Report (2026-06-18)

Good morning. I worked autonomously overnight on a dedicated branch. Everything is committed
locally, **nothing was pushed and `main` is untouched** — review the diff and merge what you like.

## TL;DR
- **Branch:** `overnight-2026-06-18` (off `main` @ f21ec17), **34 commits**, working tree clean.
- **Round 1:** shipped all 22 items from an 8-lens discovery pass (60 candidates → 22 ranked).
- **Adversarial review** of round 1 (15-agent workflow): 9 real findings, **2 high — both fixed**,
  5 low fixed, 2 low consciously left (noted below).
- **Round 2:** a second discovery pass → **14 more items** shipped (resilience timeouts/retries,
  find_duplicates, capability toggles, perf indexes, type-safety, more UX).
- **Adversarial review of round 2** (11-agent workflow): 7 real findings (all med/low), **6 fixed**
  (error-classified retry, no double-retry, abortable backoff, manifest runtime guards, dream count,
  readCapped multibyte), 1 low left (≤10s self-healing SSE heartbeat leak on reconnect).
- **36 improvements total.** `tsc` clean every commit; **10 offline suites green**; **9 new suites**.
- UI changes screenshot-verified at desktop + 375px.

## Review it
```
git -C ~/agent-harness checkout overnight-2026-06-18
git -C ~/agent-harness diff main..HEAD            # the whole night
npm run loop:test && npm run web:test && npm run fileops:test && npm run journal:test \
  && npm run embed:test && npm run store:test && npm run websink:test && npm run restart:test && npm run cap:test
npm run web    # localhost:3200 — Home, open Settings (Esc closes), tab to see the focus ring
```

## ⚠️ One thing to know
Settings → Model currently reads **OpenRouter / DeepSeek V4 Flash** (not Ollama as the old handoff
warned) — normal cloud use is fine. I confirmed this in the live UI.

## What shipped (by theme)

**Trust-critical correctness**
- **Undo survives restart + out-of-memory runs** (rank 1, the headline): every reversible op now
  persists a serializable *manifest* so a rehydrated run can reconstruct its inverses; `undoRun`
  no longer 404s for evicted/post-restart runs. New `src/server/journalRestore.ts`.
- delete_file parks same-named files under distinct Review names (no overwrite/corruption).
- Stuck-detection rewritten: only real repetition aborts, not denied/successful one-offs.
- JSON-parse guards so a corrupt DB row can't 500 a run or brick boot.
- web_search snippets now align to the right result (per-block parse).
- Zod-validate the dreaming model output before it deletes/rewrites memories.

**Perf / resilience**
- SQLite WAL + synchronous=NORMAL + busy_timeout (fewer fsyncs on the hot write path).
- Skip the synchronous per-token log write on streaming deltas.
- Calm JSON (not a raw 500) when a run fails to start; persistence writes guarded so a DB hiccup
  can't crash the worker; WebSink delta ring bounds RAM on long replies.

**New capabilities**
- `rename_file` (basename-only, journaled undo) and `folder_summary` (bounded recursive
  disk-usage, read-only — backs "what's taking up space?").

**Tests** — new offline suites: `loop`, `web`, `fileops`, `journal`, `embed`, `store`, `websink`,
plus an extended `restart` (manifest round-trip + double-undo idempotency + undoRun). Shared
`src/testutil.ts`.

**UI / a11y** — keyboard focus ring (clay, keyboard-only), aria-live/roles on the status line +
approval card, modal Esc-close + focus management, labels; Try-again + Start-something-else on
errors, composer autofocus on settle, touch-reachable Recently delete, fresh timestamps, surfaced
mid-run upload errors. Palette deliberately untouched.

**Cleanup** — pruned never-emitted event variants from the contract; moved a misplaced helper.

## Adversarial review — findings & resolution
Ran a fan-out review over the riskiest changes, with each finding independently verified.
- **FIXED (high)** Journal manifest was only persisted at turn-settle → a mid-turn crash lost data.
  Now persisted on each `tool.result` too (idempotent), closing the exact crash window Undo targets.
- **FIXED (high)** Stuck-detection reset on success → a no-op loop that always "succeeds" (clicking a
  dead button) could burn to 300 iterations. Now identical successes count too.
- **FIXED (med)** Reconstructed move/delete inverses could clobber a recreated file on double-undo →
  now guard both ends (idempotent).
- **FIXED (low)** `undoRun` resurrected evicted runs into the registry → now rebuilds a throwaway journal.
- **FIXED (low)** dream.ts dropped *all* valid items if one was malformed → now validates per element.
- **FIXED (low)** folder_summary counted Errand's own `.errand-review` → now skipped.
- **FIXED (low)** rename_file rejected valid `..`-containing names → now only rejects `.`/`..` segments.
- **LEFT (low, by choice)** WebSink reconnect can briefly gap >400 deltas mid-reply — self-heals when
  `message.completed` lands (carries full text); persisted transcript is never affected.
- **LEFT (low, by choice)** If an overwrite's snapshot write fails, the post-restart Undo is shown but
  skips — `undoSentence` already reports "1 couldn't be restored", so the user isn't misled.

## Round 2 — 14 more (after the review)
A second discovery pass, aware of round-1's changes and promoting items it had deferred for lack of
test coverage (now that the suites exist):
- **Resilience:** web_fetch/web_search now have a per-request timeout + streamed bounded body (no
  hang, no OOM); the loop has an idle-stream watchdog + explicit 120s client timeout (a stalled
  stream no longer hangs the run forever) and bounded retry-with-backoff for transient transport
  blips (only before any output, never duplicating); the extension fails parked commands instantly
  on disconnect instead of after 30s.
- **New capability:** `find_duplicates` (backs the duplicate-finder chip); on/off **capability
  toggles** in Settings (see + limit what the agent can do).
- **Perf:** expression indexes on the `lower(text)` dedup lookups; killed a `listMemories()` N+1 in
  dreaming.
- **UX:** read-only "I didn't change any files" confirmation; Try-again on a run-level start
  failure; Recently search + per-row change-count badges.
- **Type-safety:** discriminated `OpManifest` union (typed manifests, exhaustive reconstruct);
  `ToolResult<D>` generic (removed the `as any` in tool summarizers); typed `EmbedClient` seam.
- New `ext:test`; everything tsc-clean + suite-verified.

## Suggested next (your call)
- The two "left" items above, if you want them airtight.
- v8 Gmail (first OAuth pack — needs your Google Cloud project) / hosting-grade durability
  (resume mid-flight, multi-worker) — both still open from the §6b roadmap.

Full per-item detail is in `NIGHT-LOG.md`; changelog in `PLAN.md §11`.
