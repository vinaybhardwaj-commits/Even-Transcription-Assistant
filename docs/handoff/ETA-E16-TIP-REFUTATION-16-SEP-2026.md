# ETA-E16 tip — Refutation of cb35001 (E16 fix round 2) and c6e4b6d (the deploy-order proof) · 16 Sep 2026 · Refuter (Builder pane)

Branch `vinay/e16-emotion-speech-fraction`, HEAD `c6e4b6d`. Nothing was fixed, committed, pushed, merged or promoted.
Migrations ran only inside ephemeral postgres:16 containers. I touched nothing on `vinay/s1-auto-drain`. I raised K1
and K2 last round; I did not build these fixes, and I reran everything.

**A note on method, because it produced a finding.** I first worked in a `git archive` copy as usual. The gate failed
there — `tests/unit/e25-deploy-order.test.ts` shells out to `git show a05d750:lib/stt/diarize-window.ts`, and an
archive has no history. I rebuilt the scratch copy as a read-only `git clone --shared` at `c6e4b6d`, where the same
suite passes. Both results are below; the dependency is finding **T2**.

## 1. Verdicts

| Commit | Verdict |
|---|---|
| **cb35001** — E16 fix round 2 | **MERGE-READY.** K1 is dead, K2 is dead, and the R15 mark mechanism is pinned from five directions plus the database CHECK. |
| **c6e4b6d** — the deploy-order proof | **MERGE-READY, with two caveats recorded (T1, T2).** It proves the break it executes; it does not execute the third break it names, and it depends on git history. |

**The branch is clear to merge into `vinay/s1-auto-drain`**, provided the deploy order travels with it: **0097 AND
0099 must both be applied before this code deploys** (§4). Neither is applied anywhere today.

## 2. Gate — rerun by me

- In the clone (full history): `npm run typecheck` exit 0 · `npm test` **`Test Files 112 passed (112)`,
  `Tests 2675 passed (2675)`**, Docker 29.7.2, no skip variable, with `e25-deploy-order (2)`,
  `s1-emotion-zero-scored (33)` and `c2-e2e-runner (51)` all running · `npm run build` exit 0 ·
  `npm run check:silent` exit 1 with the accepted 9.
- In the archive copy: **`Tests 1 failed | 2674 passed`** — the one failure is `e25-deploy-order`, on
  `fatal: invalid object name 'a05d750'`. That is T2, not a defect in the code under test.

## 3. Priority 1 — is K1 dead?

**Yes.** `repairStaleDiarizeSegments` refuses anything but an `ok` run before it issues a statement
(`diarize-window.ts:336`), and the job passes the same value it recorded (`diarize-window.ts:76-88`). Three mutants
prove each link: removing the guard (**K1, caught, 2 tests**), refusing only `failed` so `no_speakers` is adopted
(**K1b, caught, 2**), and making the job call every run `ok` (**K1c, caught, 1**). c2 drives it through the runner.

**The one adoption path left, and why it is not K1.** A run with speakers but an empty `transcript_segments` array
ends `ok`, so the repair adopts it. Probe P1, on Postgres:
`{"repaired":true,"stored":{"state":"ok","segments_json":[],"segments_run_id":"run_empty","last_run_id":"run_empty"}}`.
State and content then come from the *same* run, which is what K1 asked for, and the window scores `no_segments`
afterwards. No fixture expresses it (**T3**).

## 4. Priority 2 — does the CHECK hold under every write path?

**Yes, structurally.** `room_emotion_window` has exactly two writers, both in `lib/emotion/store.ts`:
`recordEmotionWindow` (INSERT and the conflict branch, state and mark from the same call) and `finishEmotionWindow`
(state `ok`/`failed`, mark forced to NULL). A no-op update cannot strand a mark on a non-stale row either, because
`state` is inside the upsert's comparison tuple: if the state changes, the update fires. Mutants R15c (the CHECK
dropped) and F4a-F4e (every arm of the mark mechanism) are all caught, F4e by five tests.

**What the CHECK does not give you — the mark's FRESHNESS (finding M1).** `stale_segments_run_id` is *not* in the
upsert's comparison tuple. A second stale write that differs only in the mark therefore writes nothing. Probe P2, on
Postgres: mark `seg_A`, then a second `recordStaleWindow` with the same `diarize_run_id` and `seg_B` →
`{"first":{"stale_segments_run_id":"seg_A"},"second":{"stale_segments_run_id":"seg_A"},"moved":false}`. Unreachable
through today's callers — the enqueue scan never re-offers a stale row whose `diarize_run_id` still equals
`last_run_id`, and `segments_run_id` cannot move without `last_run_id` moving — so it is latent, not live. It is worth
recording because R15's whole scoping rests on that column being current.

## 5. Priority 3 — what does e25-deploy-order actually prove?

**It proves the break it executes, and the mechanism is indeed "a column is missing" — which is exactly what the
deploy-order constraint is.** Path A (the diarize INSERT) and path B (the emotion prepare SELECT) both fail on
pre-0099 schema with Postgres's own message; the ordered apply runs through the real route, the real files and the
real splitter; the straddle path lands NULL and is read with R17's honest text. That is a genuinely executed
constraint, not an assertion.

Three things it does not prove, two of which I ran myself:

- **T1 — the third break it names is not exercised.** The commit and the 0099 header say "every emotion window write
  fails on the missing `stale_segments_run_id`". No test does that write against a pre-0099 schema. Probe P3b, with
  0097 applied and 0099 withheld: the write dies on
  `column "stale_segments_run_id" of relation "room_emotion_window"…`. **The claim is true; it is simply unproven in
  the suite.**
- **The right order, and the deploy still breaks (the brief's construction).** Apply **0099 without 0097** — correct
  order for 0099, and the deploy is still broken. Probe P4: the emotion window write dies on `segments_unscorable`
  and the span write on `column "speech_ms" of relation "room_span_emotion" does not exist`. The test applies 0097 and
  0099 together in one runner call, so it cannot distinguish "0099 first" from "both". The branch needs **both**, and
  the commit message says so — the test does not.
- **The psql-vs-Neon ruling: I accept it, with one line added.** Paths A and B assert Postgres's own error text and
  R17 asserts a string we generate; the driver cannot change either. What the harness does change is *wrapping and
  granularity*: it runs a transaction as `BEGIN; …; COMMIT;` in one psql session, while Neon HTTP sends a batch, so
  which statement aborts and how the error surfaces to the runner's catch can differ. Nothing in the three
  assertions depends on that. **The ruling stands.**

## 6. Priority 4 — rule 21 on the new fixtures

- **Improved:** the stale mark is now *produced* by the emotion job (c2 asserts `r1.error` matches
  `diarize_segments_stale` before anything else), where last round it was seeded.
- **Still seeded:** the *divergence* that causes staleness. Every fixture sets `segmentsRunId: "run_older…"` directly.
  No test drives the operator chain end to end — score → re-diarize (creates the divergence) → emotion (marks) →
  re-diarize (cures) → rescore. My F1 finding from last round is therefore half-closed.
- **Not expressible today:** an `ok` run with empty segments (T3, P1) · a `diarize_stale` window whose mark is NULL
  being *cured* (T4, §7) · the third deploy break (T1) · 0099-without-0097 (§5) · a second stale mark under one
  `diarize_run_id` (M1, P2).

## 7. Priority 5 — mutation check: 13 caught of 16 run

Seven suites per mutant (e16, c3, c2-diarize-roles, room-diarize-job, e25-deploy-order, and s1-emotion-zero-scored
and c2-e2e-runner on real Postgres), 0 skipped. Each mutation was applied by an exact string matched once and
restored under a sha256 check.

**Caught (13):** K1 · K1b · K1c · R15a (mark-equality clause dropped) · R14/B5 (speakers not replaced) · N12 (the
`diarize_stale` state check dropped) · F4a (mark never recorded) · F4b (finish does not clear it) · F4c (INSERT never
carries it) · F4d (conflict branch does not update it) · F4e (marked against `last_run_id`) · R15c (0099's CHECK
dropped) · R17 (the reason claims "predate 0099" again).

**Equivalent (2), both as the commit claims:**
- **N13** — repair without `d.state = 'ok'`. Equivalent only while the keep-rule at `diarize-window.ts:289` stands, as
  the commit records. I re-derived it: an emotion row exists only for a window that was `ok`, and nothing moves a row
  out of `ok`.
- **N11** — repair without "segments not already this run's". For that guard to decide anything, the mark, the stored
  segments and `last_run_id` would all have to be this run's id; a mark is only written when the segments differ from
  `last_run_id`, and run ids are UUIDs that never recur.

**Real survivor (1) — T4:**
- **R15b — `e.stale_segments_run_id IS NOT DISTINCT FROM d.segments_run_id` changed to `=`.** Every test passes. A real
  value separates them: a stale window whose mark is NULL — the straddle population e25 itself creates
  (`{state: "diarize_stale", stale_segments_run_id: null}`) — would become **permanently incurable**, because
  `NULL = NULL` is unknown. Probe P5 on Postgres shows HEAD cures it:
  `{"marked":{"state":"diarize_stale","stale_segments_run_id":null},"repaired":true,"after":{"segments_run_id":"run_cure"}}`.
  The only NULL-mark fixture in the suite (`bw_e25_legacy_ok`) uses an **ok** emotion row and asserts refusal, so the
  cure of a NULL-marked *stale* window is untested. The code is right; the test is missing.

## 8. Findings

- **K1 is dead** — three mutants prove the refusal, and c2 drives it through the runner.
- **K2 is dead** — the repair replaces `speakers_json`, and B5 is caught by two tests.
- **T3:** the repair still adopts an `ok` run whose segments are empty; state and content agree, so it is not K1, but nothing pins it (P1).
- **The CHECK holds under both writers**, and a no-op update cannot strand a mark, because `state` is compared.
- **M1:** the mark's freshness is not guaranteed — `stale_segments_run_id` is missing from the upsert's comparison tuple, so a mark-only rewrite is a no-op (P2). Latent, not reachable through today's callers.
- **T1:** e25 does not exercise the third break it names; I ran it — the emotion window write dies on `stale_segments_run_id` (P3b).
- **0099 without 0097 still breaks the deploy** (P4): the span write dies on `speech_ms`. Both migrations are required, and the test applies them together.
- **The psql-vs-Neon ruling stands**; the harness changes wrapping and granularity, not the column's existence or the asserted text.
- **T4 (real survivor):** `IS NOT DISTINCT FROM` → `=` passes every test, yet would leave every NULL-marked stale window incurable (P5).
- **T2:** `e25-deploy-order` depends on `a05d750` being reachable in git history — red in an archive or shallow clone, green in a full clone.
- **Rule 21:** the mark is now produced, the divergence is still seeded; no fixture runs the operator chain end to end.

## 9. Anything unrun
- **`swift test`: not run** (R26 — scribe may be building, and it must run alone). No Swift changed in either commit.
  **`swift build` not run either**, per R27: it would not be evidence about the Swift tests.
- **No migration applied outside an ephemeral container.** 0097 and 0099 remain unapplied everywhere.
- R18's backfill and the R24 count are the Orchestrator's rulings and were not re-measured; this pane has no live database.

## 10. Scratch evidence (session scratchpad, not committed)
`e16tip2/` (the clone): `test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `mutate.mjs`,
`mutation-results.json`, probe `tests/unit/zz-refuter-p5.test.ts`. `e16tip/` (the archive): `test-clean.log` with the
git-history failure, and probes P1–P4 in `tests/unit/zz-refuter-e25.test.ts`.

## 11. Subagents
None.
