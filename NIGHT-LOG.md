# Errand — Overnight Autonomous Session (2026-06-18)

Branch: `overnight-2026-06-18` (off `main` @ f21ec17). Working autonomously until Abhiram
wakes and stops me. Goal: find + ship high-value, **autonomous-safe** improvements, each
verified (tsc clean, tests, screenshot where UI) and committed individually.

## Rules I'm holding myself to
- tsc clean at every commit; never break the live app.
- One feature per commit, clear message. No pushing to `main`, no force-push, nothing outward-facing.
- Additive/safe only — no external auth, no destructive ops, no touching `errand.db` (it's on Ollama/llama3.2:3b).
- Each item: design → implement → verify → adversarial review → commit → log here.
- If something needs Abhiram (a decision, a real-verify, a creds step), park it with a note and move on.

## Status
- Baseline: tsc EXIT 0, clean tree, ~7,126 LOC. ✅

## Backlog (ranked — from 8-lens discovery, 60 candidates → 22 deduped/ranked)
Trust-critical correctness → cheap perf/resilience → new tools+tests → test suites → UI → cleanup.

1. Undo survives restart + out-of-memory runs (manifest persistence + undoRun rehydrate) — L/med
2. delete_file unique review dest (same-basename can't corrupt) — S/low
3. Stuck-detection counts only consecutive FAILED repeats — M/med
4. Guard getStoredRun/getEvents JSON.parse (corrupt row can't 500/brick boot) — S/low
5. web_search per-block parse (snippets align to right result) — M/low
6. Zod-validate dreaming model output before delete/rewrite — S/low
7. SQLite WAL + synchronous=NORMAL + busy_timeout — S/low
8. Skip per-token Logger.log on streaming deltas — S/low
9. try/catch POST /api/runs startRun → calm JSON not raw 500 — S/low
10. Wrap persistence writes (attachPersistence + runTurn.finally) — S/low
11. Bound WebSink buffer + exclude non-persisted deltas — M/med
12. rename_file tool (basename-only, journaled Undo) — S/low
13. folder_summary tool (bounded recursive disk-usage, read-only) — M/low
14. fileops:test (new tools register, validate, round-trip undo) — S/low
15. loop safety-rail suite (stub client) — M/low
16. embed.ts pure-function offline suite — M/low
17. journal honesty suite (demotion, LIFO, partial-fail) — S/low
18. store write-side suite (dedup, cap, malformed-JSON) — M/low
19. a11y pass (contrast, focus-visible, aria-live, labels, modal) — L/low
20. Run View recovery + Home polish (try-again, autofocus, touch delete) — M/low
21. Prune dead event variants (refusal/thinking.delta/cancelled) — S/med
22. Relocate misplaced relocationPhrase() helper — S/low

Full plans + verify steps: workflow output `wjw139l7i.output`. Cross-cutting: 1/2/12/13/14
all touch files.ts+journal — batch together. 3+15 share looptest.ts.

## Shipped tonight (newest last) — branch `overnight-2026-06-18`
- **rank 7** store: SQLite WAL + synchronous=NORMAL + busy_timeout. ✅ tsc, restart+mem
- **rank 4** store: safeParse guards on getEvents/getStoredRun + reconcileOrphans boot-guard. ✅
- **rank 10** runRegistry: try/catch persistence writes (sink + runTurn.finally). ✅ tsc
- **rank 3** loop: post-run stuck-detection (consecutive failures only) + offline looptest. ✅ loop:test
- **rank 8** loop: skip per-token Logger.log on streaming deltas. ✅
- **rank 9** api/runs: calm JSON on startRun throw, not raw 500. ✅ tsc
- **rank 6** dream: Zod-validate model output before destructive de-dup. ✅ tsc
- **rank 5** web_search: per-block snippet parse (no drift) + offline webtest. ✅ web:test
- **rank 22** files: relocate misplaced relocationPhrase() helper below imports. ✅ tsc
- **rank 2** files: delete_file unique Review dest (same-basename can't corrupt). ✅ fileops:test
- **rank 12** files: rename_file tool (basename-only, journaled undo). ✅ fileops:test
- **rank 13** files: folder_summary tool (bounded recursive disk-usage, read-only). ✅ fileops:test
- **rank 14** new fileops:test (register/validate/undo round-trip, 28 checks). ✅
- **rank 1** undo: persist journal manifest → Undo survives restart + out-of-memory runs;
  undoRun rehydrates (no 404). New `src/server/journalRestore.ts`. ✅ restart:test (extended)
- New test infra: `src/testutil.ts` (shared wellFormed), `loop:test`, `web:test`, `fileops:test`.

## Parked / needs Abhiram
_(none yet)_
