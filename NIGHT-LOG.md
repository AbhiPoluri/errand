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

## Shipped tonight
_(none yet)_

## Parked / needs Abhiram
_(none yet)_
