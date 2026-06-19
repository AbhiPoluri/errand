# Errand — Autonomous Loop Queue

This is the working queue + rulebook for the self-driving dev loop (run via `/loop`). It is the
loop's MEMORY: each iteration reads it to decide what to do next, and updates it when done. Full
history/detail lives in `PLAN.md` §11 and `HANDOFF.md`; this file is just the actionable queue.

## The cycle (what the loop does each iteration)

1. `cd ~/agent-harness`. Confirm the branch is `durability-electron` and the tree is clean
   (`git status`). If the tree is dirty from a half-done iteration, finish or revert it first.
2. Read this file's **Backlog** + the **Guardrails** below, and skim `HANDOFF.md`.
3. Pick the SINGLE highest-priority **unblocked, autonomously-safe** task (top of the Backlog).
4. **Plan** it briefly (a few bullets in your reply — what files, what approach, what test).
5. **Implement** it, following the repo's conventions (TypeScript strict; a `*:test` tsx script for
   new logic; comments that match the surrounding density).
6. **Verify**: `npx tsc --noEmit` clean AND the relevant `npm run *:test` green AND the full offline
   suite stays green. If a change breaks something you can't fix this iteration, **revert it**
   (`git restore` / `git checkout`) — never leave the tree broken or the suite red.
7. **Review**: adversarially review your own diff (the repo's 3-lens pattern — spawn a review
   Workflow when the diff is non-trivial). Fix every confirmed real finding.
8. **Commit** on `durability-electron` with a clear `type(scope):` message + the Co-Authored-By
   trailer. One task = one (or few) focused commits.
9. **Update this file**: check off the task, move it to the Done log with its commit hash + date,
   and add any follow-ups you discovered to the Backlog (correctly prioritized).
10. **Report** one short paragraph: what you did, the verification result, and what's next.
11. End the iteration. (The `/loop` mechanism resumes for the next task.)

## Guardrails (HARD rules — do not violate)

- **One task per iteration.** Keep each iteration small + reviewable. Don't chain tasks.
- **Stay on `durability-electron`.** Never push, never merge to main, never force-push. Commit locally only.
- **Never touch things that need the user.** If a task needs the user's secrets, accounts, or a
  decision — Apple Developer signing/notarization, Gmail/Calendar OAuth, anything requiring a login
  or a paid key — DO NOT attempt it. Tag it `[needs-user]` in the Backlog and skip to the next safe task.
- **Nothing destructive / irreversible.** No deleting the user's data, no `rm -rf` outside build dirs
  (`.next`, `dist`, `/tmp`), no editing files outside `~/agent-harness`, no network posts on the
  user's behalf. Don't restart the running Errand.app unless a task specifically requires it (it drops
  the extension connection).
- **Green or reverted.** Every iteration ends with `tsc` clean + the offline suite green + a clean
  committed tree. If you can't get there, revert your changes and tag the task `[blocked: <reason>]`.
- **If no safe, unblocked task remains, STOP** and say so — don't invent busywork or refactor for its
  own sake.
- When unsure whether something is safe to do autonomously, treat it as `[needs-user]` and skip it.

## Backlog (priority order — work the top unblocked item)

- [ ] **Boot-timeout cleanup** (low): if waitForServer times out while the fork is still ALIVE (hung,
  not crashed), kill that fork before showing the error window so it can't linger holding :3200 / the DB.
  The crash/exit case is already handled; only the rare hang-without-crash isn't.

## Blocked — needs the user / attended (DO NOT attempt unattended in the loop)

- [needs-attended] **Phase 3c — resume() engine (the risky core).** Foundation DONE (3a schema, 3b
  400-safe checkpoints, journal-before-mutate, reconcile clears zombie turn_state). REMAINING is a
  CORE-LOOP refactor that could break every run if wrong, so do it WITH the user, not unattended:
  `AgentRunner.resume(state)` re-enters `send()` at the checkpoint's phase/cursor (skip resolved calls;
  reversible re-run, permanent → uncertain via a `tool_inflight` marker), re-park an `awaiting_approval`
  checkpoint so `/decision` continues the run, a boot classify-and-resume pass, all behind
  `ERRAND_RESUME=1` (flip default only after a `resume:test` proving end-to-end resume). Optional
  hardening: throttled per-result checkpoint; `id: tc.id || randomUUID()` at the source for the
  dup/empty-id 400 edge. The whole persistence spine it needs is already built + tested.
- [needs-attended] **Browser: Gmail email-row open reliability.** The one Gmail step still finicky.
  An extension change that can only be VERIFIED with a real logged-in browser + an extension reload —
  not autonomously checkable, so do it attended. (Diagnose from the reader/click path in background.js.)
- [needs-user] **Signing + notarization** of Errand.app — requires the user's Apple Developer identity.
- [needs-user] **v8 Gmail read+triage+draft** — requires the user to set up Google OAuth + authorize.
- [needs-user] **v9 Calendar** — rides the v8 Google grant.
- [needs-user] **Push/merge `durability-electron` to main** — the user reviews + decides.

## Done log (newest first)

- 2026-06-19 — Weak/free-model warning for browser tasks. `modelLikelyWeakForBrowser(id)` flags
  OpenRouter `:free` tiers and sub-8B models (new `modelParamCountB` id parser), never the curated
  presets; surfaced as `browserWeak` from /api/model (GET+POST). Settings shows a soft amber hint by
  the model picker ONLY when a weak model is selected AND the browser pack is on, refreshed live on a
  model/endpoint switch (applyModelResp). Hint, not a block. New `models:test` (17 assertions);
  tsc clean; 23 offline suites green. Adversarial review → no defects (regex doesn't misfire on
  gpt-4.1/gemini-2.5/q4_K_M/MoE ids; `<8` boundary correct). `6eab090`. ⚠️ visual appearance to be
  eyeballed in a real app run (attended) — logic + wiring verified, pixels not.
- 2026-06-19 — Polish / adversarial-review sweep over the Electron + folders + extension changes. A
  3-phase review workflow surfaced 8 confirmed-real findings (1 false positive correctly rejected); all
  fixed: electron lifecycle hardening (boot preflight + waitForServer reject-on-exit + error view; async
  before-quit window with a 4s force-kill fallback; crash respawn with capped backoff; acknowledged
  key-save), recursive `.env` strip + `dist:dmg` dmg target, extension borrowed-tab reuse gate (v0.2.2),
  paths comment. A self-review workflow then found + fixed 5 follow-on regressions: phantom respawn on a
  boot crash → `booting` guard; cached shutdown promise so a 2nd signal/beforeExit can't exit
  mid-cleanup; `NEXT_MANUAL_SIG_HANDLE=1` so Next doesn't race our shutdown; extension `workTabOwned`
  flag robust to grouping failure; prepare-standalone EACCES resilience. tsc clean; 22 offline suites
  green; `.env` strip live-verified (root+nested stripped, node_modules+unreadable skipped).
  `3ad0ab4`, `e611f9b`, `72258b0`. ⚠️ ATTENDED verification still owed (not autonomously checkable):
  desktop key save→restart round-trip; extension v0.2.2 reload + a web→desktop tab-hijack check;
  before-quit / NEXT_MANUAL_SIG_HANDLE quit cleanliness in the real packaged app.
- 2026-06-19 — instrumentation.ts: register() runs bootstrap() at server startup (explicit boot hook,
  Next instrumentationHook flag), module-init kept as idempotent fallback. Standalone smoke confirmed
  register() fires before serving. `88c6869`.
- 2026-06-19 — in-app OpenRouter key entry: Settings field → POST /api/key → main process
  (safeStorage) → encrypt + restart. Renderer never sees the key; web-mode hidden. Security review
  → no leaks; fixed a restart port-rebind race + key-shape check. Verified live (renders + GET +
  boot). `3917aad`. Follow-ups: (a) user should smoke-test the full save→restart once (not
  auto-tested — would overwrite the real key); (b) to get it in the packaged Errand.app, repackage
  (`npm run dist`).
- 2026-06-19 — Phase 3c foundation: `reconcileOrphans` clears a settled zombie's `turn_state` (the
  resume-safety orphan guard), atomically in its tx. `restart:test` extended. The rest of 3c (the
  resume() engine — re-entering the loop) moved to needs-attended (risky core-loop refactor). `d229913`.
- 2026-06-19 — journal-before-mutate: synchronous `Journal.onRecord` hook persists the Undo manifest at
  record-time (inside tool.run, no async yield) instead of on the later tool.result event — closes the
  un-undoable-after-restart window. Wired in runRegistry (both paths); idempotent vs the existing
  backstops. Adversarial review → no bugs. `journal:test` extended. `a8d1cb4`.
- 2026-06-19 — Phase 3b: incremental mid-turn persistence — `backfillToolResults` (400-safe snapshot),
  `checkpoint` in the loop (after-assistant + pre-approval boundaries), `saveTurnState/getTurnState/
  clearTurnState`, wired in runRegistry (cleared at settle). Additive (no-op default). 3-lens review →
  dropped the costly per-result checkpoint + added the deleted-guard. `resume:test`. `a0c97b3`.
- 2026-06-19 — Phase 3a: `turn_state` + `tool_inflight` tables + `runs.resumable` column as migration
  v2 (additive, no behavior change yet — the resumable-runs persistence spine). `d89861f`.
- 2026-06-18 — Phase 0 foundation (migrations/tx/seq/mutex) `19865b6`; Phase 1 core extraction
  (paths+key `535cf95`, bootstrap/shutdown `ff99604`); Phase 2 Electron wrap (app `c5bf518`, package
  `068b019`, icon `bf074c6`, .env-strip `150b912`); folders safe-folder auto-create `209a0a3`;
  extension tab-group fix `e20f02c`; set-key utility `646e870`. (Full detail: PLAN §11.)
</content>
