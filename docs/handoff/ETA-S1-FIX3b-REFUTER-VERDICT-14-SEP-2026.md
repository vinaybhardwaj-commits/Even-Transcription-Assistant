# ETA — S1 FIX3b — REFUTER VERDICT
**14 Sep 2026 · ETA-Refuter (Opus) · repo at `6067ba8` on `vinay/s1-auto-drain` · everything rerun serially in this repo**

**OVERALL: FAIL.** R1–R13 each pass as specified. One path found this round, X1 below, still leaves the window row stale relative to its segment rows. Round 3's G2 says no path may do that, and C9 exists to enforce it.

Evidence, all untracked under `docs/handoff/scratch/`, id-shaped tokens masked: `FIX3b-REFUTER-{gate,mutations,runs,probe-out}-14-SEP-2026.log`; scripts `FIX3b-REFUTER-mutate.sh.txt` and `FIX3b-REFUTER-probe.{test,vitest.config}.mts` (`.mts` keeps them outside both tsconfigs: `tsc --listFilesOnly` lists 0 scratch files).

## R1 — the diff is the contract — PASS
`git diff --stat 8ac9e24..HEAD` → `15 files changed, 1276 insertions(+), 153 deletions(-)`.
- Code: `lib/emotion/store.ts`, `lib/jobs/kinds/emotion-window.ts`, `lib/stt/auto-drain.ts`, `tests/support/repo-files.ts` (the named guard script), `tests/support/s1-pg.ts`, three S1 test files, and the new `tests/unit/s1-guard-staged.test.ts`.
- Bus documents: the five named in kickoff §5, plus the one-line edit to the FIX2 report.
- `git diff --name-only 8ac9e24..HEAD -- <the whole brief §4 R1 untouched list> app` → **0 lines**.

## R2 — the gate — PASS
- `npx tsc --noEmit` → `tsc exit 0`
- `npm test` → ` Test Files  107 passed (107)` · `      Tests  2583 passed (2583)` · `npm test exit 0`
- `npm run build` → ` ✓ Compiled successfully in 2.5s` · `build exit 0`
- `npm run check:silent` → `Found 9 silent-failure handler(s)` · `check:silent exit 1`. All nine are in `app/[slug]/…` (`finalize-text`, `finalize-upload`, `process` ×5, `NoteComposerClient` ×2), and none of those files is in this round's diff. Still 9.
- The tracked tree was clean after the build.

## R3 — C8, the selector — PASS
- `auto-drain.ts:113`: `JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE`. It is in the FROM clause, so it filters before `LIMIT ${limit}` (`:127`), and reads the column directly.
- An inner join drops a window with no matching room or a NULL `room_id`, so it fails closed.
- Mutation (condition dropped) → `Tests  3 failed | 45 passed (48)`, then `RESTORED` with `cmp` equal to HEAD.
- No test seeds a window whose room is missing. Fail-closed is proven by the join's semantics, not by a case.

## R4 — C9, write iff changed — PASS (see X1)
Three arms, identical in both upserts: stored row `failed` (`store.ts:154`, `:246`); `diarize_run_id <>` (NOT NULL in 0089); the six-tuple `(state, error, planned, scored, skipped, failed) IS DISTINCT FROM` (`:158`, `:250`).
- `vitest -t "C9"` → `Tests  4 passed | 10 skipped (14)`: the identical re-run leaves `scored_at` and `attempts` alone; the differing re-run rewrites.
- `c2-e2e-runner.test.ts`: blob identical to `8ac9e24`, and IDEMPOTENT passes in the full-file gate run (48/48).
- Filtered alone (`-t IDEMPOTENT`) it fails with `expected 'failed' to be 'done'`. **The identical command fails the same way on a clean clone at `8ac9e24`**, so this order dependence predates FIX3b (see outside-contract item O2).

Brief §3's reshape is semantically equivalent. An aggregate subquery with no GROUP BY yields exactly one row, as the CTE did, and `WHERE TRUE` is only there to remove the parse ambiguity with `ON CONFLICT`.

## R5 — C10, null vs counts — PASS
`grep -n "fail(" lib/jobs/kinds/emotion-window.ts`. **There are two pre-delete `fail()` sites, not four:**
- health `:105` and planning `:120`: both `"none"`, before the delete at `:125`;
- catch paths `:230` and `:241`: `"none"`;
- only warm `:148`, diarize-changed `:163`, score `:168` and cap `:172` use `"rows"`, all after `:125`.

Counts are filtered by `window_id` and `diarize_run_id`, and the delete at `:125` is window-wide in the same attempt, so no earlier attempt's rows can be counted.

## R6 — C11, the guard over the staged tree — PASS
- `vitest run tests/unit/s1-guard-staged.test.ts` → `Tests  4 passed (4)`.
- In **this** repo, a new `docs/handoff/FIX3b-REFUTER-GUARD-PROBE-14-SEP-2026.md` with one id-shaped token built at runtime (never typed or printed): untracked `??` → `Tests  3 passed (3)`; `git add` → `Tests  1 failed | 2 passed (3)`, offender `"docs/handoff/FIX3b-REFUTER-GUARD-PROBE-14-SEP-2026.md (1)"`; `git rm --cached` + delete → `file gone`, `Tests  3 passed (3)`.
- `git diff --numstat 8ac9e24..HEAD -- docs/handoff/ETA-S1-FIX2-REPORT-14-SEP-2026.md` → `1	1`, hunks 1. HEAD copy: 0 shape matches, and the replacement `doc_<id>` is present.

## R7 — C15.1, the Builder's F1 refusal — PASS (F1 upheld)
- Blob hashes at `8ac9e24` and HEAD are identical for `docs/handoff/scratch/C2-REFUTER-NOTES.md` (`f4f4cdf9ef13`) and `tests/unit/no-real-clinician-ids.test.ts` (`154ea3239165`).
- Node, parsing HEAD's regex and allowlist and printing no tokens: `allowlist entries: 20 | entries NOT a full shape match: 0` · `C2-REFUTER-NOTES.md shape matches: 2 | on allowlist: 2 | unlisted: 0`.
- The guard's own "every allowlisted id has the shape" case passed in R2.

## R8 — C12, the harness — PASS; F3 exposure measured
Via the probe, driving `tests/support/s1-pg.ts` directly:
- **R8.1** leading `--` comment, leading `(`, `VALUES`, `TABLE` → each `threw UnrecognisedStatementError`.
- **R8.2** header `:17-21` names both divergences: bigint as a JSON NUMBER, and row ORDER not guaranteed.
- **R8.3** `mainStatementAt` (`:72`) returns the first top-level SELECT/INSERT/UPDATE/DELETE. For `WITH … INSERT … SELECT`, no RETURNING gives `[]`, RETURNING gives `[{"n":7}]`, and the table holds `[{"n":7},{"n":42}]`: both statements ran whole.
- **R8.4** `pg-harness.ts` is unedited since `8ac9e24` (last commit `17ed22b`). The same two statements through its `makeSql` → **both threw**, with `rows_inserted: [{"n":0}]`: it splits at `lastTopLevelSelect` (`:105-106`).
- **Exposure: 8 statements in `lib/` start with `WITH`; 0 of 8 have the breaking shape today.** 5 end in SELECT and split correctly (`dashboard.ts:75`, `:287`, `emotion/store.ts:202`, `encounter/admin.ts:546`, `voiceprint-load.ts:288`); 3 are UPDATE/DELETE … RETURNING with no top-level SELECT and are wrapped whole (`jobs/store.ts:87`, `room-install.ts:664`, `stt/fanout.ts:307`). The bug is real and latent.

## R9 — C13, order independence — PASS
`ETA_S1_REVERSE_ORDER=1 npx vitest run tests/unit/s1-emotion-zero-scored.test.ts` → `exit 0`, `Tests  14 passed (14)`. The title shows `(REVERSED ORDER)` and the first case run was `planned = 0`.

## R10 — C14, the real JWT — PASS
- `vi.mock("@/lib/auth")` appears 0 times. The success test (`s1-auto-drain.test.ts:596`) mints with `signAdminJwt` and asserts `vi.isMockFunction(verifyAdminJwt) === false`.
- The four negatives (`:609` different secret, `:619` `MIGRATION_SECRET` only, `:630` empty `admin_id` + malformed token) all passed in R2 (48/48).
- The ordered mutation (one byte of the test secret corrupted) → `Tests  11 passed | 37 skipped`. **It does not fail, and it cannot**: `mint` sets `JWT_SECRET_ADMIN` and `verifyAdminJwt` reads that same variable, so signing and verifying still agree.
- The mutation that does separate them (verify key differs from sign key in the success test) → `Tests  1 failed`. So the suite does detect a key mismatch.
- **Cookie read still mocked:** this weakens only the cookie-name lookup in `lib/cookie`. The signature, the audience and the `admin_id` decision are all real. The helper is the one `bench/drain` uses in production.

## R11 — mutations, sampled — PASS (6 of 6 claimed counts reproduced; every file `RESTORED`, `cmp` equal)
Flag misspelt `32 failed` (claimed 32) · C9 `failed` arm removed `1` (1) · C11 staged-copy read removed `2` (2) · C12 `WITH … INSERT` misclassified `1` (1) · C14 JWT unverified `1` (1) · max-age clamp 48→99 `1` (1).

## R12 — F2, the Builder's correction of the ruling — BUILDER IS RIGHT
- `lib/emotion/enqueue.ts:63`: `OR (e.state = 'failed' AND e.attempts < ${EMOTION_MAX_ATTEMPTS}))`, where `e` is `room_emotion_window` (`:57`). **The bound reads `room_emotion_window.attempts`.**
- The runner's counter is `scribe_job.failures` (`runner.ts:53`) and is per job. Each retry is a new job starting at 0, so it does not bound retries across jobs.
- Under strict write-iff-changed, an identical failure never increments `attempts`, and the window would be re-queued on every emotion cron tick with no end.
- The `failed` arm is the minimum fix. It widens writes only for rows already `failed`; settled `ok` and `no_segments` rows stay write-iff-changed. Removing it fails exactly the one pinning test (R11).
- The ruling's sentence is inaccurate; the code is right.

## R13 — F5, the pre-delete failure record — REPORTED, not ruled
Reproduced by the probe: a settled window after one clean run, then a re-run with `/health` down.
- **After run 1:** window `ok`, scored 2, attempts 1; segment rows `scored, scored`.
- **After run 2:** job `fail`. Window `failed`, error `emotion_unavailable…`, planned/scored NULL, attempts 2; segment rows still `scored, scored`.
- **What a reader joining `room_emotion_window` to `room_span_emotion` sees:** `window_state failed, has_error true, window_scored NULL, rows_scored 2, rows_same_run true`. That is a failed window over two scored segments of the same diarize run, with no marker that the rows belong to the previous attempt.
- **Consumers:** `git grep room_emotion_window|room_span_emotion` outside the writer finds only `lib/emotion/enqueue.ts:41,57`. It reads the window row alone and never joins the segment rows. **No consumer in the repo is misled today.** A future reader of the pair would be.

## New finding
**X1 — C9's six-tuple leaves the window row stale on model and cap. Reproduced.**
- Same diarize run, identical counts, service model changed (probe: `m`/`int8` → a second model/subfolder) → `out done, window_row left_final`.
- The window row still says the old model and subfolder with `scored_at` unchanged. Both segment rows now carry the new model and subfolder.
- The tuple (`store.ts:156-160`, `:248-252`) omits `model`, `model_key`, `subfolder` and `cap_s`.
- Round 3 G2: *"No path may leave the window row stale relative to its segments."* This is such a path.
- Scope: an emotion model change followed by a same-run re-score. No consumer reads these columns today.
- I would expect adding `model, model_key, subfolder, cap_s` to the tuple to keep IDEMPOTENT green (an identical re-run carries an identical model), but I did not test it. **Not fixed; the Orchestrator's call.**

## H1–H5 from my FIX2 verdict
- **H1 — closed.** The guard scans the staged tree (R6), and the FIX2 report placeholder is replaced. It still depends on staging before the gate; nothing enforces that at commit time.
- **H2 — closed by the round-4 ruling.** F8 verified on a throwaway postgres:16: `-c "SET lock_timeout = '3s';" -f file` carries into the file (`SHOW` → `3s`). With another session holding a lock on `bench_window`, 0092 → `ERROR: canceling statement due to lock timeout`, `psql exit 3 after 3 s`.
- **H3 — closed.** Unclassifiable statements throw (R8.1); both remaining divergences are documented.
- **H4 — closed.** A real token is verified by the real `verifyAdminJwt`; the cookie read is still mocked (R10).
- **H5 — closed.** Reversed order passes 14/14 (R9).

## Outside the contract — stated, not acted on
- **O1:** R10's mutation, as written in the brief, cannot discriminate; the key-divergence mutation does.
- **O2:** the `c2-e2e-runner` IDEMPOTENT tests (voiceprint and C3) depend on order. They fail when filtered alone, identically at `8ac9e24`. Same class as H5, in an untouched file.
- **O3:** every container this review started had a unique name (`eta-refuter-*`) and was removed. The repo suites used their own fixed names serially, with no parallel runs. The Mini was not touched.

## Final `git status --short`
```
?? docs/handoff/ETA-M2-ROUTER-MEASUREMENT-14-SEP-2026.md
?? docs/handoff/ETA-M2-ROUTER-MEASUREMENT-CC-KICKOFF-14-SEP-2026.md
?? docs/handoff/ETA-M3-ROUTER-CONCURRENCY-14-SEP-2026.md
?? docs/handoff/ETA-M3-ROUTER-CONCURRENCY-CC-KICKOFF-14-SEP-2026.md
?? docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-14-SEP-2026.md
?? docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-CC-KICKOFF-14-SEP-2026.md
?? docs/handoff/ETA-M5-TRANSCRIPT-ALIGNMENT-14-SEP-2026.md
?? docs/handoff/ETA-M5-TRANSCRIPT-ALIGNMENT-CC-KICKOFF-14-SEP-2026.md
?? docs/handoff/ETA-M5-VERDICT-AND-ENGINE-STATUS-14-SEP-2026.md
?? docs/handoff/ETA-M6-SCRIPT-CENSUS-CC-KICKOFF-14-SEP-2026.md
?? docs/handoff/ETA-S1-FIX2-REFUTER-BRIEF-14-SEP-2026.md
?? docs/handoff/ETA-S1-FIX3-CC-KICKOFF-14-SEP-2026.md
?? docs/handoff/ETA-S1-FIX3b-REFUTER-BRIEF-14-SEP-2026.md
?? docs/handoff/ETA-S1-FIX3b-REFUTER-VERDICT-14-SEP-2026.md
?? docs/handoff/ETA-S1-REFUTER-BRIEF-14-SEP-2026.md
?? docs/handoff/ETA-S1-ROUND3-RULINGS-AND-M2-VERDICT-14-SEP-2026.md
?? docs/handoff/ETA-SLICE-E-MCP-REGROUP-EVIDENCE-13-SEP-2026.md
?? docs/handoff/ETA-SLICE-E-MCP-REGROUP-REPORT-13-SEP-2026.md
?? docs/handoff/scratch/C2-MERGE-GATE-REFUTER-NOTES-13-SEP-2026.md
?? docs/handoff/scratch/C2-MERGE-GATE-probe-out.json
?? docs/handoff/scratch/C2-MERGE-GATE-probe.test.ts.txt
?? docs/handoff/scratch/C2-REFUTER-FINAL-NOTES.md
?? docs/handoff/scratch/C2-REFUTER-FINAL2-NOTES-13-SEP-2026.md
?? docs/handoff/scratch/C2-REFUTER-FINAL2-probe-out.json
?? docs/handoff/scratch/C2-REFUTER-FINAL2-probe.test.ts.txt
?? docs/handoff/scratch/C3-REFUTER-NOTES-13-SEP-2026.md
?? docs/handoff/scratch/C3-REFUTER-mini-probe.py.txt
?? docs/handoff/scratch/C3-REFUTER-mini-sandbox.py.txt
?? docs/handoff/scratch/C3-REFUTER-probe-out.json
?? docs/handoff/scratch/C3-REFUTER-probe.test.ts.txt
?? docs/handoff/scratch/FIX3b-REFUTER-gate-14-SEP-2026.log
?? docs/handoff/scratch/FIX3b-REFUTER-mutate.sh.txt
?? docs/handoff/scratch/FIX3b-REFUTER-mutations-14-SEP-2026.log
?? docs/handoff/scratch/FIX3b-REFUTER-probe-out-14-SEP-2026.log
?? docs/handoff/scratch/FIX3b-REFUTER-probe.test.mts
?? docs/handoff/scratch/FIX3b-REFUTER-probe.vitest.config.mts
?? docs/handoff/scratch/FIX3b-REFUTER-runs-14-SEP-2026.log
?? docs/handoff/scratch/M4-INPUT-M3-ROUTE-TRANSLATE-FALSE-14-SEP-2026.json
?? docs/handoff/scratch/M4-INPUT-M3-WHISPER-ALONE-14-SEP-2026.json
?? docs/handoff/scratch/M4-MEASURE-14-SEP-2026.py.txt
?? docs/handoff/scratch/M4-MEASURE-OUT-14-SEP-2026.json
?? docs/handoff/scratch/M5-MEASURE-14-SEP-2026.py.txt
?? docs/handoff/scratch/M5-MEASURE-OUT-14-SEP-2026.json
?? docs/handoff/scratch/SLICE-E-MCP-REGROUP-PROPOSAL-13-SEP-2026.md
(tracked/staged changes: none — every line above is untracked `??`)
```
