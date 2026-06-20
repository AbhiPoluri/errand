# Errand — Autonomous Loop Queue

This is the working queue + rulebook for the self-driving dev loop (run via `/loop`). It is the
loop's MEMORY: each iteration reads it to decide what to do next, and updates it when done. Full
history/detail lives in `PLAN.md` §11 and `HANDOFF.md`; this file is just the actionable queue.

## The cycle (what the loop does each iteration)

1. `cd ~/agent-harness`. Confirm the branch is `durability-electron` and the tree is clean
   (`git status`). If the tree is dirty from a half-done iteration, finish or revert it first.
2. Read this file's **Backlog** + the **Guardrails** below, and skim `HANDOFF.md`.
3. **Pick or discover a task.** If the Backlog has an unblocked, autonomously-safe item, take the
   SINGLE highest-priority one (top). **If the Backlog has no such item** (empty, or only
   needs-user/needs-attended remain), run the **Discovery pass** (see the section below) to surface
   real, concrete, autonomously-safe work, add it to the Backlog correctly prioritized, then take the
   top one. Only if Discovery genuinely turns up nothing real do you stop (report it + do nothing).
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
- **When the Backlog runs dry, DISCOVER — don't idle.** Run the Discovery pass to find new real work.
  Stop and report only if Discovery genuinely surfaces nothing concrete and safe. **Quality bar still
  holds: never invent busywork or refactor for its own sake** — a discovered task must be a real
  improvement (a genuine bug, a real coverage/edge-case gap, a concrete reliability/UX win), not churn.
- When unsure whether something is safe to do autonomously, treat it as `[needs-user]` and skip it.

## Discovery pass (how to find new work when the Backlog is dry)

Goal: surface REAL, concrete, autonomously-safe tasks — never manufacture churn. Prefer a focused
review **Workflow** that fans out across the codebase looking for, in rough priority order:
1. **Genuine bugs / latent races / unhandled edge cases** — especially in code that can't be unit-run
   (electron, extension) or in error paths.
2. **Coverage gaps** — modules with real logic but no `*:test`, or a tested module missing an important
   case. Adding a test that documents/locks current behavior counts.
3. **Code↔comment/doc drift** — a comment or HANDOFF/PLAN claim that the code no longer matches.
4. **Concrete reliability or UX polish** — a silent-failure path, a confusing message, a small
   consumer-facing rough edge with a clear fix.
5. **Footguns / dead code with a concrete payoff** — not style nits.

Each discovered task MUST be: **concrete** (names the file + the behavior), **autonomously-safe** (no
secrets/accounts/signing/OAuth/main/destructive), **verifiable** (tsc + a `*:test` or a runnable
check), and **small** (one iteration). Add each to the Backlog with a one-line rationale; work the top
one this iteration and leave the rest queued. **De-dupe against the Done log** so finished work isn't
re-done and previously-rejected ideas don't reappear. If a candidate is risky or needs the user, file
it under needs-attended/needs-user instead of the safe Backlog.

## Backlog (priority order — work the top unblocked item)

_(Queued by the 2026-06-19 Discovery #2 pass — 4 parallel scouts (deep), each candidate triaged. Work
top-down; re-run Discovery when this empties again.)_

_(Queued by the 2026-06-19 Discovery #3 pass — 3 focused scouts (third sweep, high bar). Work top-down.)_

- [ ] **(med) Cover save_skill cross-slug collision** (`src/tools/skills.ts:84-87`, `server/skills.ts:88`):
  `slugForName` collapses distinct names to one folder ("Tidy Downloads"/"tidy_downloads" → tidy-downloads;
  symbol/emoji-only → "skill"); the only non-clobber guard is `existsSync(slug)`, but skillTest only
  re-saves the SAME name. Add: save name A, then a DIFFERENT name slugging identically → 2nd returns
  ok:false/exists, the on-disk SKILL.md still has A's frontmatter (no clobber), getSkill resolves A.
  Additive. Verify: skill:test + tsc.
- [ ] **(med) Cover store journal-op null + corrupt-manifest round-trip** (`src/server/store.ts:283,294`):
  appendJournalOp with manifest:null → SQL NULL → getJournalOps returns manifest:null; and a corrupt
  manifest blob (raw-SQL inject `'{not json'`) → getJournalOps returns manifest:null without throwing
  (graceful degrade). Mirror storetest's existing raw-SQL corruption pattern. Additive.
- [ ] **(med) Cover getEvents skip-unparseable-row** (`src/server/store.ts:251-259`): reconcileOrphans'
  MAX(seq) correctness depends on getEvents dropping corrupt rows, but no test injects a corrupt event
  payload. Add: 3 valid events, raw-SQL corrupt the middle one, assert getEvents returns the 2 good ones
  and doesn't throw. Additive.
- [ ] **(med) Fix HANDOFF offline-suite count again** (`HANDOFF.md:24,95`): says 26, but `session:test`
  landed after → 27. Update the count + add `session` to the list. Docs-only. (Skip the stale cron-id in
  HANDOFF — session-volatile by design; LOOP is authoritative.)

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

- 2026-06-19 — Correct the browser-approval claim in the system prompt (from Discovery #3). The prompt
  said "clicking and typing will ask the user first," but typing + benign clicks run autonomously
  (reversible); only a consequential click (reversibility "unknown") or Enter pauses. Rewrote the line to
  match the real gate; webtest guards the false claim from returning. tsc clean; 27 suites green. `41cf128`.
- 2026-06-19 — **Discovery #3** (third sweep) + close a symlinked-parent SANDBOX ESCAPE. 3 focused scouts
  (high bar) queued 5 real tasks. Worked the security bug this iteration: write_file/make_folder/move_file/
  copy_file applied the realpath guard only to existing files / sources, so a symlinked parent dir
  (safe/link→/outside) let a NEW destination write OUTSIDE the sandbox. Extended the deepestExisting +
  assertRealWithin guard (already used by zip/document) to all four; moved deepestExisting into fileutil.ts.
  fileopsTest symlink-escape case VERIFIED to bite (without the guard, write_file writes pwned.txt outside,
  ok:true). tsc clean; 27 offline suites green. `ec30807`.
- 2026-06-19 — Lock extract_zip over-cap atomic rollback (from Discovery #2, last of the batch). A 5001-
  entry stored-zip case asserts an over-MAX_ENTRIES archive → ok:false/unpack_failed AND no half-written
  dest folder (atomic rollback). No production change (real over-cap zip, ~1s). tsc clean; 27 suites
  green. `bdfb2a0`. **Discovery #2 batch (8 tasks) fully cleared.**
- 2026-06-19 — Cover embedMany malformed-index remap (from Discovery #2). embed:test now locks an
  out-of-range index (dropped by the slot guard, no throw/drift) and a missing index (positional `?? i`
  fallback) — the order-preserving contract memory retrieval rests on. Additive. tsc clean; 27 suites
  green. `a4ba61f`.
- 2026-06-19 — Cover extractXlsx boolean/formula/error cell types (from Discovery #2). Added a buildZip
  xlsx fixture (t="b"→TRUE/FALSE, t="str" formula, t="e" #DIV/0!) asserted via extractDocument; these
  cellValue branches were unexercised. Additive (doc:test). tsc clean; 27 offline suites + doc green.
  `e784f5f`.
- 2026-06-19 — Direct unit test for backfillToolResults (from Discovery #2). New session:test (10
  assertions) locks the dedup + multi-strand branches the indirect resumeTest coverage didn't pin:
  fully-resolved unchanged, 1→1, 2→2 in order, already-resolved gets no duplicate, input not mutated.
  Additive. tsc clean; 27 offline suites green. `6f5e402`.
- 2026-06-19 — Cover pack.ts contentToText + isError→uncertain mapping (from Discovery #2). Stub-McpClient
  cases (no spawn) lock the multi-part join / json-stringify / unknown-type fallback / 6000-char
  truncation, the isError→{ok:false,outcome:"uncertain"} safety contract, thrown→uncertain, and the
  mcpToolName hash-suffix shape. Additive. tsc clean; 26 suites green. `0fc6aa8`.
- 2026-06-19 — Cover journalRestore copy + make_folder reconstructed inverses (from Discovery #2). The
  restart-Undo fallback only E2E-undid move/write/delete/rename; now the copy inverse (removes the copy),
  make_folder inverse (removes an empty created dir), and critically the "LEAVES a folder the user
  filled" safety guard are exercised, + corrupt make_folder/delete manifests → no inverse. Additive.
  tsc clean; 26 suites green. `2c4c066`.
- 2026-06-19 — Fix the length/content_filter tool_call strand (from Discovery #2). A model cut off
  (finish_reason "length") or filtered ("content_filter") WHILE emitting tool_calls left an assistant
  tool_calls message with no matching tool result → every follow-up turn 400'd, wedging the conversation.
  Added backfillStrandedCalls() before both early returns (mirrors the finally backfill). looptest +2
  (4b/5b) — VERIFIED they fail without the fix (via a temp toggle) and pass with it. tsc clean; 26 offline
  suites green. `84e37da`.
- 2026-06-19 — **Discovery #2** (deep pass) + clickrisk money-movement fix. 4 parallel scouts went deep
  (loop/session internals, parsing/tools, server internals, untested-module coverage); triaged → queued
  8 tasks (3 high incl. a real run-wedge bug + 2 safety-contract coverage gaps, 4 med, 1 low). Worked the
  top safety bug this iteration: **clickrisk withdraw/transfer/wire** — the highest-stakes autonomy gate
  classified "Withdraw"/"Transfer" buttons BENIGN, so they'd auto-click on a logged-in bank. Added them
  to RISKY (word-bounded; "Wired" stays benign); only widens the pause set. clickrisk:test +6. tsc clean;
  26 offline suites green. `1dc72eb`.
- 2026-06-19 — `save_as_document` empty-content guard (from Discovery #1, last of the batch). Empty/
  whitespace-only content silently produced a blank docx / 1×1 empty-cell xlsx reported as "Saved."; now
  refused with a calm message. docWriteTest +3. tsc clean; 26 suites green. `082e05e`. **Discovery #1
  batch (9 tasks) fully cleared.**
- 2026-06-19 — Harden DELETE routes (from Discovery #1). DELETE /api/runs now de-dupes + caps the ids
  batch (200) and reports the distinct count; DELETE /api/memory requires type ∈ {memory,suggestion}
  (default memory) so a typo'd type can't silently delete from the wrong store. runroute:test +7
  assertions. tsc clean; 26 suites green. `482cd18`.
- 2026-06-19 — Fix HANDOFF offline-suite drift (from Discovery #1). Corrected "22 offline test suites"
  → 26 (lines 24 + 95) and added models/mcpconfig/userun/runroute to the list; verified the list equals
  all package.json *:test minus mem/doc/ocr. Docs-only. `b8ef572`.
- 2026-06-19 — Tighten run-route status codes + decision allow-list (from Discovery #1). /auto, /cancel,
  /decision now 404 on a missing run (matched /message + /undo, was 200 {ok:false}); /decision's accepted
  set narrowed to approved/denied/approved_always so internal cancelled/expired can't be injected via the
  open route. New `runroute:test` (7 assertions, drives the handlers with a bogus run). tsc clean; 26
  offline suites green. `bd0e2b3`.
- 2026-06-19 — Lock the folders symlink-escape defense (from Discovery #1). `checkRoots` compares roots
  by resolved real path so a symlink can't masquerade as an allowed folder; only a plain non-allowed
  path was tested. Added 2 cases (symlink → allowed safe folder accepted via real path; symlink under
  the data dir → outside target rejected). Purely additive. tsc clean; 26 suites green. `2fc58e3`.
- 2026-06-19 — MCP onClose idempotency (from Discovery #1). A transport can fire close twice (over-long
  path reports the real reason, then the killed child's exit fires close() again with no error); onClose
  ran both times, overwriting `closeErr` with a generic message + double-firing onDisconnect. Added
  `if (this.closed) return` (first close wins). mcpTest drives a double-close via a fake transport: 4
  assertions (onDisconnect once, real reason preserved, isClosed, post-close request rejects with the
  real reason). tsc clean; 26 offline suites green. `9e8e172`.
- 2026-06-19 — Fix the stuck approval card (from Discovery #1). `decide()` never read the decision
  POST and only cleared the amber card on the `approval.resolved` SSE — so when `runRegistry.decide()`
  returned false (run evicted/restarted, or approval expired server-side) the card wedged forever on
  the app's most trust-critical surface. Now awaits the POST and on not-ok clears the card + shows a
  calm "ask me again" snag via the new pure `resolveApprovalFailure` helper (guarded against clobbering
  a fresh approval / firing on success). New `userun:test` (8 assertions). Adversarial review: no
  correctness defects. tsc clean; 26 offline suites green. `5292976`.
- 2026-06-19 — `mcpconfig:test` (from Discovery #1). Locked loadMcpServers/saveMcpServers sanitization
  (17 assertions: malformed/non-array JSON → [] no throw, bad entries dropped, args string-only, env
  object-only, enabled defaults true via !==false, round-trip). Isolated ERRAND_DB, offline. tsc clean;
  24 offline suites green. `f0a7d64`.
- 2026-06-19 — Lock the bash catastrophic-command denylist (from Discovery #1). `run_command`'s DENY
  gate (the highest-stakes runtime safety check) had no test — only the output cap did. Exported
  `DENY`+`SHELL_META` and added 27 assertions: 12 catastrophic strings match, 9 benign don't (incl. the
  `rm -rf ../../..` traversal + relative `chmod 777` false-negatives, locked as currently-allowed),
  `run()` short-circuits to `error:"blocked"` without spawning, and `describe()` gives "unknown"
  reversibility + the unpredictable-wording branch for shell-meta. Purely additive. tsc clean; 23 suites
  green. `d85fd9e`.
- 2026-06-19 — **Discovery pass #1** (first run of the new find-work behavior). 4 parallel scouts swept
  the codebase (agent-loop+tools, server+caps/mcp/skills, API+UI, coverage+drift); candidates triaged
  for real/safe/verifiable/small/non-dupe. Queued 9 tasks into the Backlog (2 high coverage, 1 high UI
  bug, 5 med, 2 low). Worked the top genuine bug this iteration:
  **web_search res.ok** — `webSearch.run` never checked `res.ok` (unlike web_fetch), so a DDG
  rate-limit/5xx parsed to zero rows and surfaced as "no_results", telling the model the topic has no
  web presence when the request was blocked. Added the `if (!res.ok) return http_<status>` guard;
  `webtest` now stubs fetch to lock 429→http_429 and 200-empty→no_results. tsc clean; 23 offline suites
  green. `bbdbc64`. (The discovery Workflow harness wedged mid-run for the 3rd time this session — ran
  the scouts as direct parallel subagents instead, which is reliable.)
- 2026-06-19 — Boot-timeout cleanup (electron): on a waitForServer rejection, kill a still-alive
  (hung/timed-out) fork and null it so no zombie core lingers behind the error window holding :3200 +
  the SQLite WAL writer. Crash-exit path no-ops (serverProc already null); guards prevent respawn /
  before-quit double-act. Adversarial review of all 4 lifecycle interactions → no defects. tsc clean;
  23 offline suites green. `2b21fc2`. **This emptied the autonomously-safe backlog.**
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

## Cron heartbeat (what drives this loop)

**Drive model (2026-06-19): continuous self-paced — cron is only a FAILSAFE.** The loop runs
iterations back-to-back without waiting for the heartbeat: after each one it re-arms a short
`ScheduleWakeup` (~60s) to immediately continue. The cron below is the safety net — if the self-driven
chain ever breaks (a missed wakeup, the turn ends, the session restarts) the 10-min cron picks the loop
back up. Both inject the same HEARTBEAT prompt; the "finish mid-flight / clean tree / one task" guardrails
make an occasional double-fire harmless (the later one just finds a clean tree and takes the next task).

A **session-only** cron (`CronCreate`, `durable:false`) fires the HEARTBEAT prompt every 10 min while
the REPL is idle. As of 2026-06-19 the live job is `16adc4c3` (`7,17,...,57 * * * *`); it replaced
`4461c404` (reprompted when Discovery was added) and the original `ef511639` (gone zombie — listed but
not firing after its session ended). **Session-only = dies when Claude closes; recreate it next session** (or use `durable:true` to
persist across restarts — the user declined that on 2026-06-19, preferring session-only). Auto-expires
after 7 days regardless. **An empty backlog no longer means no-op** — each fire runs the Discovery
pass to find and work new safe tasks (see "Discovery pass" above). To pause the loop entirely, add a
STOP banner at the top of this file or `CronDelete 16adc4c3`.
</content>
