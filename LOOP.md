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

- [ ] **journal-before-mutate.** Persist the journal manifest BEFORE the fs write (currently written on
  the later `tool.result`, so a crash between mutate and event = un-undoable). Inject a persist hook
  into the journal/ctx; reorder record-before-mutate in the mutating file tools. Pairs with the
  `tool_inflight` work. (HIGH-sev from the audit; see PLAN §11.)
- [ ] **Phase 3c — resume engine (consume turn_state).** The payoff of 3a+3b: `AgentRunner.resume(state)`
  that re-enters `send()` at the checkpoint's phase/cursor (skipping already-resolved calls; reversible
  re-run, permanent → uncertain via a `tool_inflight` marker), re-parks an `awaiting_approval`
  checkpoint so `/decision` continues the run, and a boot `bootstrap()` classify-and-resume pass. MUST:
  `reconcileOrphans` should `clearTurnState` for each zombie it settles, and resume must IGNORE/delete a
  `turn_state` row whose `runs` row is missing/stopped (orphan guard — see the 3b review). Optional:
  add throttled per-result checkpointing if resume timings warrant finer granularity; harden tool_call
  id assignment at the source (`id: tc.id || randomUUID()`) to kill the dup/empty-id 400 edge for good.
  Ship behind `ERRAND_RESUME=1`, flip default after a `resume:test` proving end-to-end resume. (Big —
  may span iterations.)
- [ ] **In-app key-entry screen.** A Settings field to enter the OpenRouter key → an IPC/route path →
  `safeStorage` blob (the `set-key.cjs` logic, but from the UI), so a fresh install works without the
  env/CLI. The renderer must never see the key. (Makes the packaged app self-sufficient.)
- [ ] **`instrumentation.ts` boot refinement.** Move `bootstrap()` out of the runRegistry module-eval
  call into a Next `instrumentation.ts` `register()` hook (+ `experimental.instrumentationHook`),
  guarded on `NEXT_RUNTIME==='nodejs'`, so the boot step is explicit (Electron-ready). Verify the dev
  server + standalone server still reconcile before serving.
- [ ] **Browser: Gmail email-row open reliability.** The one Gmail step still finicky (opening an email
  row). Diagnose from the reader/click path; make it robust. (Extension change → note it needs a reload.)
- [ ] **Polish / adversarial-review sweep** over this session's Electron + folders + extension changes —
  surface and fix any real findings.
- [ ] **Weak/free-model warning** for browser tasks (the model picker should warn when a weak model is
  selected for a browser-heavy task; free models flail).

## Blocked — needs the user (DO NOT attempt in the loop)

- [needs-user] **Signing + notarization** of Errand.app — requires the user's Apple Developer identity.
- [needs-user] **v8 Gmail read+triage+draft** — requires the user to set up Google OAuth + authorize.
- [needs-user] **v9 Calendar** — rides the v8 Google grant.
- [needs-user] **Push/merge `durability-electron` to main** — the user reviews + decides.

## Done log (newest first)

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
