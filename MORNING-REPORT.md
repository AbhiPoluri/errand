# Errand — Overnight Report (2026-06-18)

Good morning. I worked autonomously overnight on a dedicated branch. Everything is committed
locally, **nothing was pushed and `main` is untouched** — review the diff and merge what you like.

## TL;DR
- **Branch:** `overnight-2026-06-18` (off `main` @ f21ec17), **44 commits**, working tree clean.
- **Round 1:** all 22 items from an 8-lens discovery pass (60 candidates → 22). **Reviewed**
  (15-agent workflow): 9 findings, 2 high — both fixed.
- **Round 2:** 14 more (resilience timeouts/retries, capability toggles, perf, type-safety, UX).
  **Reviewed** (11-agent): 7 findings, 6 fixed + the 7th (SSE heartbeat) fixed too.
- **Round 3:** 13 more (truncated-scan honesty, run_command OOM guard, find_duplicates/extract_zip,
  recent_changes, first-run welcome, export transcript, prompt/research/scoping guidance, SSE
  teardown). 1 deferred for your review (create_zip — a from-scratch ZIP writer). **Reviewed**
  (11-agent): 6 findings (extract_zip had none), 5 fixed, 1 low left (chunked-body bound, not a
  regression, localhost-only).
- **Round 4** (higher bar — the quick-win well is thinning): 4 more, incl. a real **security fix**
  (server-side folder allow-list — a crafted request could've pointed the agent at ~/.ssh), browser
  click-risk hardening (unlabeled buttons were auto-clicked), `find_files` (search by name/content),
  web-failure honesty. **Reviewed** (7-agent): 3 findings, all on find_files, all fixed.
- **53 improvements, 4 adversarial-review passes (~22 findings fixed), 52 commits.** `tsc` clean
  every commit; **12 offline test suites green**; **12 new suites added.** UI screenshot-verified.
- **Deferred for your review (2):** `create_zip` and `save_as_document` — both from-scratch binary
  format *writers* (ZIP / OOXML). Reading is shipped + safe; writing wants your eye (each has a
  round-trip-through-the-reader test ready to make it safe).

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

## Round 3 — 13 more (net-new features + trust/safety polish)
- **Trust/correctness:** find_duplicates & folder_summary now report a truncated scan honestly
  (no more confident "No duplicates found" on a partial walk); run_command caps its output on
  append (was an OOM risk — a multi-MB chunk ballooned RAM) and reports accurate bytes; today's
  date is injected into the system prompt so relative-time asks don't anchor on the training cutoff.
- **New capability:** `extract_zip` — unpack a .zip into a new folder (read_file refused bare zips);
  reuses the proven ZIP reader, zip-slip-safe, journaled one-step undo. `recent_changes` — "what
  changed in this folder lately" (newest-first, optional time window).
- **UX:** a dismissible first-run welcome card (states the one-folder + always-ask promise); an
  Export-transcript action (whole conversation → Markdown); the default safe-folder scope now
  explains itself; move_file points renames at rename_file (no more misleading "Move" narration).
- **Agent guidance:** prompt now nudges look-first on broad requests, prefer-undoable actions over
  run_command, cite the web source you actually opened, and end with a plain recap.
- **Resource hygiene:** the main run SSE tears down on a terminal event (no lingering buffer/heartbeat);
  /api/ext/result bounds the body + normalizes the result envelope.
- **Deferred for you:** `create_zip` — a from-scratch ZIP *writer* (CRC-32 + headers). It's the one
  piece I didn't want to ship unreviewed; the round-trip test against the existing reader makes it
  safe to add when you're up.

## Round 4 — 4 more (higher bar)
- **Security:** the folder picker is an allow-list, but the server never enforced it — a crafted
  `POST /api/runs` with `roots:["~/.ssh"]` made that the agent's working root and the confinement
  happily operated there. `checkRoots` now requires each root to be one of the offered folders
  (by resolved real path, so a symlink can't masquerade).
- **Browser safety:** the click-risk classifier auto-clicked *unlabeled* buttons on your real Chrome
  and missed common consequential verbs (Continue/Accept/Add to cart/Archive…). Now unlabeled
  non-navigation elements default to "ask first" and the verb set is widened.
- **`find_files`:** locate a file by name OR by what's written inside it (text/CSV/MD/PDF/Word/Excel)
  — the biggest everyday gap (list_files was one level + names only).
- **Honesty:** the agent won't answer a web question from memory when the page won't open.

## Why I stopped finding more (and what's left)
Four discovery rounds in, the safe + high-value + quick-win well has genuinely run shallow — round 4
already had to reach, and its review found only find_files nits (fixed). What remains is deliberately
NOT done unsupervised:
- **`create_zip` / `save_as_document`** — from-scratch ZIP/OOXML *writers*. Reading is shipped + safe;
  writing binary formats wants your eye (each has a round-trip-through-the-reader test ready).
- **v8 Gmail / v9 Calendar** — need your Google Cloud project + OAuth consent (not autonomous-safe).
- **Hosting-grade durability** (resume mid-flight, multi-worker) — a core-run-state refactor; too big
  to land unreviewed at the tail of a long run.
- The two low items left from earlier reviews, if you want them airtight.

Everything shipped is on the branch, individually committed, tsc-clean, and test-covered. Review the
diff (`git diff main..overnight-2026-06-18`) and merge what you like. Per-item log in `NIGHT-LOG.md`;
changelog in `PLAN.md §11`.
