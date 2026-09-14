# ETA — S1 FIX3b — REPORT
**14 September 2026 · Builder · branch `vinay/s1-auto-drain` · one new commit on `8ac9e24` · not pushed**

## 1. Commit

One new commit on `8ac9e248a08d7aaf0cb98561cdaf6f9ceb4efb51`. `8ac9e24` was not amended. Nothing was pushed, and `main` was not touched. This report is inside that commit, so it cannot name the commit's SHA. The SHA is printed in the terminal, and `git log -1 --format=%H -- docs/handoff/ETA-S1-FIX3b-REPORT-14-SEP-2026.md` returns it.

Pre-flight passed:
- `git rev-parse --abbrev-ref HEAD` returned `vinay/s1-auto-drain`.
- `git rev-parse HEAD` returned `8ac9e24…`.
- `git status --porcelain | grep -v '^??'` was empty.

**Order of work, as C11 requires.**
1. Every file this commit carries was staged by exact filename before the gate: the code, the tests, the bus documents, and a draft of this report containing no id-shaped text.
2. `git diff --name-only` (unstaged changes to tracked files) was empty for both gate runs.
3. After the gate, only this report's text changed. It was re-staged, and both repo guards were re-run over the final staged set (§4).

## 2. Gate

**The first full run was RED.** Five `c2-e2e-runner` C3 emotion tests failed:
- THE CAP IS READ FROM /health
- SERVICE DOWN
- DIARIZE RE-RAN
- both P1 cap tests

The cause was the new `recordEmotionWindow` statement, which began `WITH seg AS (…) INSERT … SELECT …`. The untouched `tests/support/pg-harness.ts` splits any statement that starts with `WITH` at its last top-level `SELECT`, which cut that `INSERT … SELECT` in half. Neon would have run the statement as written.

The fix was in my statement, not in that harness: the counts became a `FROM (…) AS seg` subquery, followed by `WHERE TRUE` so `ON CONFLICT` is not read as part of the `FROM`. The SQL is equivalent and the guard is unchanged. `c2-e2e-runner.test.ts` was not edited.

**The second full run, on the re-staged tree, was green.** Each line is quoted from that run:
- `npx tsc --noEmit` — no output; `tsc exit 0`
- `npm test` (runs `tsc --noEmit -p tsconfig.tests.json`, then `vitest run`) — ` Test Files  107 passed (107)` · `      Tests  2583 passed (2583)` · `npm test exit 0`. Nothing was skipped, and all real-Postgres suites ran:
  - ` ✓ tests/unit/c2-e2e-runner.test.ts (48 tests)` — IDEMPOTENT included, file unedited
  - ` ✓ tests/unit/s1-auto-drain.test.ts (48 tests)`
  - ` ✓ tests/unit/s1-emotion-zero-scored.test.ts (14 tests)`
  - ` ✓ tests/unit/s1-fix2-migrations.test.ts (8 tests)`
  - ` ✓ tests/unit/s1-guard-staged.test.ts (4 tests)`
  - ` ✓ tests/unit/no-real-clinician-ids.test.ts (3 tests)`
  - ` ✓ tests/unit/no-identity-literals.test.ts (2 tests)`
- `npm run build` — ` ✓ Compiled successfully in 3.0s` · `build exit 0` (repo `CLAUDE.md`)
- `npm run check:silent` — `Found 9 silent-failure handler(s)` · `check:silent exit 1`. These are the 9 accepted at `1193083`; none is in a file this round touched.
- Swift — out of scope.

The mutation run (§6) came after this gate. Every mutated file was compared byte-for-byte against a backup taken after the gate (`RESTORED` printed for both batches), and `git diff --name-only` was empty afterwards.

## 3. C13 — the emotion tests in reversed order

`ETA_S1_REVERSE_ORDER=1 npx vitest run tests/unit/s1-emotion-zero-scored.test.ts`: **`Tests  14 passed (14)`**, exit 0. The describe title printed `(REVERSED ORDER)`, and the first case to run was `planned = 0`, which is last in normal order. I ran it twice: once before and once after the `recordEmotionWindow` reshape in §2, and both runs passed 14 of 14.

Every case seeds its own window id and passes its own service behaviour to `runKind`. No case reads another's state.

## 4. C11 / C15 — the id guard over the staged set

**The guard file changed is `tests/support/repo-files.ts`,** which decides what the id guards and the identity-literal guard scan.
- `git ls-files` already lists the index, which is to say staged files.
- `textOf` now also reads a file's **staged** copy wherever it differs from the working copy (`git diff --name-only`, then `git show :<path>`). A match in either copy counts.
- A staged file deleted from the working tree is still scanned.
- The exemption for untracked `docs/handoff/` files is kept.
- The two existing callers of `repoFiles`/`textOf` outside this round's files (`c3-emotion`, `c2-e2e-runner`) only run a regex over the text, so reading both copies is safe for them.

**Offender lists over the staged set:**
- With this report as a draft: `no-real-clinician-ids` 3/3 passed, `no-identity-literals` 2/2 passed. **Offender list: empty.**
- After this final report was staged, both were re-run before the commit; that result is printed in the terminal, and the commit exists only because it was empty.
- The first attempt at this gate showed the rule working. The FIX2 report's `(1)` offender still counted while its fix was only in the working copy. Staging the one-token replacement cleared it.

**The FIX2 report.** Its placeholder was replaced with `doc_<id>`: `git diff --numstat` shows `1 1`, one hunk, nothing else changed.

**The three Orchestrator documents.** Re-read after the addendum; each has **0** shape matches.

**C15.1 — `docs/handoff/scratch/C2-REFUTER-NOTES.md` was NOT edited.**
- It is tracked. Its two id-shaped tokens (lines 9 and 12) are **both already on `SYNTHETIC_CLINICIAN_IDS`**: masked shape `aaa_aaaa9999`, the synthetic `doc_fake` + four digits form.
- The guard's own `unlistedIds` counts **0** for that file, which is why the live guard never flagged it.
- The ruling's goal (both tokens are allowlisted synthetic ids) already holds, so there was nothing to replace. No allowlist entry was added, and `tests/unit/no-real-clinician-ids.test.ts` is unchanged.
- **Flag F1:** the addendum's premise that the two tokens "cannot be confirmed absent from the clinician table" does not apply: they are the synthetic ids the allowlist exists for.

## 5. Files

`git diff --cached --stat 8ac9e24`, taken before this report's final text; the report itself is the 15th file:
```
 .../ETA-S1-FIX2-REFUTER-VERDICT-14-SEP-2026.md     |  44 ++++
 docs/handoff/ETA-S1-FIX2-REPORT-14-SEP-2026.md     |   2 +-
 docs/handoff/ETA-S1-FIX3-REPORT-14-SEP-2026.md     |  97 ++++++++
 .../handoff/ETA-S1-FIX3b-CC-KICKOFF-14-SEP-2026.md | 129 ++++++++++
 docs/handoff/ETA-S1-ROUND4-RULINGS-14-SEP-2026.md  | 146 +++++++++++
 lib/emotion/store.ts                               |  73 ++++--
 lib/jobs/kinds/emotion-window.ts                   |  31 ++-
 lib/stt/auto-drain.ts                              |  18 +-
 tests/support/repo-files.ts                        |  48 +++-
 tests/support/s1-pg.ts                             |  52 +++-
 tests/unit/s1-auto-drain.test.ts                   | 103 ++++++--
 tests/unit/s1-emotion-zero-scored.test.ts          | 268 ++++++++++++++-------
 tests/unit/s1-fix2-migrations.test.ts              |  25 +-
 tests/unit/s1-guard-staged.test.ts                 |  79 ++++++
 14 files changed, 962 insertions(+), 153 deletions(-)
```
Bus documents committed, by exact filename:
- `ETA-S1-FIX3b-CC-KICKOFF-14-SEP-2026.md`
- `ETA-S1-ROUND4-RULINGS-14-SEP-2026.md`
- `ETA-S1-FIX3-REPORT-14-SEP-2026.md` (the stop report)
- `ETA-S1-FIX2-REFUTER-VERDICT-14-SEP-2026.md`
- this report
- plus the one-token edit to the tracked `ETA-S1-FIX2-REPORT-14-SEP-2026.md`

**Nothing on the untouched list moved.** `git diff --cached --name-only 8ac9e24` printed 0 lines over:
- `tests/unit/c2-e2e-runner.test.ts` · `app/api/admin/drain-windows/route.ts` · `db/migrations`
- `lib/stt/room-drain.ts` · `lib/bench-window.ts` · `lib/stt/fanout.ts`
- `lib/emotion/enqueue.ts` · `lib/emotion/client.ts`
- `lib/mcp` · `lib/stt/adapters`
- `lib/jobs/runner.ts` · `lib/jobs/store.ts` · `lib/jobs/submit.ts`
- `vercel.json` · `apps` · `package.json`
- `docs/handoff/scratch` · `tests/unit/no-real-clinician-ids.test.ts`

`tests/support/pg-harness.ts` is also untouched.

**What each change does:**
- **C8** — the selector joins `bench_session` and `room` with `r.transcript_enabled = TRUE`, before the `LIMIT`.
  - **It reads `room.transcript_enabled` directly**, the column `lib/room-switches` reads. That module has only per-room readers, and a per-room check after the `LIMIT` would let Transcript-off windows hold the slot again.
  - An unknown room drops out of the join, which fails closed as the helper does.
  - `drainRoomWindow`'s own `isTranscriptEnabled` check on entry is untouched (a test asserts the line is still there) and stays the authority.
- **C9** — both window-row upserts share one guard: write when the stored row **failed**, **or** belongs to an older diarize run, **or** its `(state, error, segments_planned, segments_scored, segments_skipped, segments_failed)` `IS DISTINCT FROM` what this write derives.
  - A re-run that reproduces the same result writes nothing.
  - A re-run whose rows now say something else rewrites the row, and this covers `fail()`.
  - IDEMPOTENT passes unedited. See F2 on the `failed` arm.
- **C10** — `fail()` takes a named count source at every call site:
  - `"none"`, which records NULL counts: health `:105` and planning `:120` (before this attempt's delete; `:96`/`:111` in the kickoff's numbering), and the catch paths `:230` and `:241`.
  - `"rows"`, which counts from `room_span_emotion` in the write: warm `:148`, diarize changed `:163`, score `:168`, cap changed `:172`.
  - `recordEmotionWindow` now takes explicit counts (only the unchanged `no_segments` path uses them), from-rows counts, or none.
- **C11** — `tests/support/repo-files.ts`, described in §4. Proven in a throwaway git repository by `tests/unit/s1-guard-staged.test.ts`:
  - an untracked bus document is exempt, and the same document once staged is caught;
  - a staged copy with the token is caught after its working copy is cleaned, and clears once the clean copy is staged;
  - a dirty working copy over a clean staged copy is caught;
  - a staged file deleted from disk is still scanned.
- **C12** — `tests/support/s1-pg.ts`:
  - A statement whose first word is not SELECT, WITH, INSERT, UPDATE or DELETE (a leading comment, `(`, `VALUES`, `TABLE`) **throws `UnrecognisedStatementError`**.
  - The header records the two unfixed divergences: `bigint` returns as a number where Neon returns a string, and row order is not guaranteed without ORDER BY.
  - Writing this surfaced a third harness bug, now fixed: it found the main statement of a `WITH` as the *last* SELECT, which misread `WITH … INSERT … SELECT`. It now takes the first top-level SELECT, INSERT, UPDATE or DELETE. That is the same bug `pg-harness.ts` has (§2, F3).
- **C14** — `vi.mock("@/lib/auth")` is gone.
  - The success test mints a real token with `signAdminJwt` (test env var `JWT_SECRET_ADMIN`, name only) and the real `verifyAdminJwt` verifies it. The test asserts `verifyAdminJwt` is not a mock.
  - Negatives: a token signed under a different secret gets 401; a real token with an empty `admin_id` gets 401 `admin_id_missing_from_token`; a malformed token gets 401; a `MIGRATION_SECRET`-only POST gets 401 with its message.
  - The cookie read stays mocked, because `next/headers` has no request context in a unit test. The email comes from `makeFakeOperator`.

## 6. Mutation check — 43 of 43 removals failed a test

Each mutation was applied, its test file rerun, and the file restored. The number is how many tests failed.

**Environment reads — 11 of 11:**
- env name misspelt: `AUTO_DRAIN_BATCH_LIMIT` 3 · `AUTO_DRAIN_MAX_AGE_HOURS` 3 · `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` 3 · `ROOM_AUTO_DRAIN_ENABLED` 32
- default changed: batch 1→2: 1 · max age 6→7: 1 · cooldown 60→61: 1
- clamp bound changed: cooldown min 5→1: 1 · cooldown max 1440→9999: 1 · max-age max 48→99: 1 · batch max 10→99: 1

**C8 — 2 of 2:** Transcript join removed: 3 · `transcript_enabled` condition dropped: 3.

**C9 — 4 of 4:**
- differs-arm removed from both upserts: 3
- `failed` arm removed from both (the retry bound): 1
- differs-arm off in `recordEmotionWindow` only (the `fail()` path): 2
- differs-arm off in `finishEmotionWindow` only: 7

**C10 — 5 of 5:**
- scored not from rows on the fail path: 2
- warm failure records none: 2
- count source ignored: 1
- catch path uses rows: 1
- `fail()` reverted to memory counts: 2

**C11 — 3 of 3:** staged copy not read: 2 · staged-but-deleted dropped: 1 · bus exemption removed: 1.

**C12 — 2 of 2:** unrecognised statement not thrown: 1 · `WITH … INSERT` misclassified as returning: 1.

**C14 — 1 of 1:** JWT payload trusted without signature verification (route mutated temporarily, restored): 1.

**Carried forward and re-run — 15 of 15:**
- N1: window-as-unit delete removed: 3 · finish outcome from memory: 2
- C1: legacy row removed: 4
- C6: refusal not set: 3 · not cleared: 3 · cooldown clause removed: 4
- SQL hard-coded: cooldown `60::int`: 1 · max age `6::int`: 1
- C2: `opts.actor` ignored: 3 · actor pre-check removed: 1
- S1: order `ASC`: 2 · grid clause: 1 · `room_day` clause: 1 · live-job status: 1 · flag ignored: 6

## 7. SQL — every changed string verbatim. All INFERRED; none has run against the live database

**7.1 The selector** (`lib/stt/auto-drain.ts`). **It reads `room.transcript_enabled` directly** (C8):
```sql
SELECT w.id
  FROM bench_window w
  JOIN bench_session s ON s.id = w.session_id
  JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
 WHERE w.state = 'closed'
   AND w.grid_aligned = TRUE
   AND w.room_day_id IS NOT NULL
   AND w.closed_at >= NOW() - (${AUTO_DRAIN_MAX_AGE_HOURS}::int * INTERVAL '1 hour')
   AND (w.auto_drain_refused_at IS NULL
        OR w.auto_drain_refused_at < NOW() - (${AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES}::int * INTERVAL '1 minute'))
   AND NOT EXISTS (
     SELECT 1 FROM scribe_job j
      WHERE j.kind = ${ROOM_WINDOW_KIND}
        AND j.args->>'window_id' = w.id
        AND j.status IN ('queued', 'running')
   )
 ORDER BY w.closed_at DESC
 LIMIT ${limit}
```
Source columns: `room.transcript_enabled` (0065), `bench_session.room_id` (0041).

**7.2 `recordEmotionWindow`** (`lib/emotion/store.ts`; used by `fail()` and `no_segments`):
```sql
INSERT INTO room_emotion_window
  (window_id, room_day_id, state, diarize_run_id, error, model, model_key, subfolder, cap_s,
   segments_planned, segments_scored, segments_skipped, segments_failed, calls, warmup_json, timing_json, scored_at)
SELECT ${r.windowId}::text, ${r.roomDayId}::text, ${r.state}::text, ${r.diarizeRunId}::text, ${r.error === null ? null : r.error.slice(0, 300)}::text,
       ${r.model ?? null}::text, ${r.model_key ?? null}::text, ${r.subfolder ?? null}::text, ${r.cap_s ?? null}::double precision,
       ${c?.planned ?? null}::int,
       CASE WHEN ${fromRows}::boolean THEN seg.scored  ELSE ${explicit?.scored ?? null}::int END,
       CASE WHEN ${fromRows}::boolean THEN seg.skipped ELSE ${explicit?.skipped ?? null}::int END,
       CASE WHEN ${fromRows}::boolean THEN seg.failed  ELSE ${explicit?.failed ?? null}::int END,
       ${c?.calls ?? null}::int,
       ${r.warmup === undefined ? null : JSON.stringify(r.warmup)}::jsonb, ${r.timing === undefined ? null : JSON.stringify(r.timing)}::jsonb, NOW()
  FROM (
    SELECT count(*) FILTER (WHERE state = 'scored')::int  AS scored,
           count(*) FILTER (WHERE state = 'failed')::int  AS failed,
           count(*) FILTER (WHERE state = 'skipped')::int AS skipped
      FROM room_span_emotion
     WHERE window_id = ${r.windowId}::text AND diarize_run_id = ${r.diarizeRunId}::text
  ) AS seg
 WHERE TRUE
ON CONFLICT (window_id) DO UPDATE SET
  room_day_id      = EXCLUDED.room_day_id,
  state            = EXCLUDED.state,
  error            = EXCLUDED.error,
  model            = EXCLUDED.model,
  model_key        = EXCLUDED.model_key,
  subfolder        = EXCLUDED.subfolder,
  cap_s            = EXCLUDED.cap_s,
  segments_planned = EXCLUDED.segments_planned,
  segments_scored  = EXCLUDED.segments_scored,
  segments_skipped = EXCLUDED.segments_skipped,
  segments_failed  = EXCLUDED.segments_failed,
  calls            = EXCLUDED.calls,
  warmup_json      = EXCLUDED.warmup_json,
  timing_json      = EXCLUDED.timing_json,
  scored_at        = EXCLUDED.scored_at,
  attempts         = CASE WHEN room_emotion_window.diarize_run_id = EXCLUDED.diarize_run_id THEN room_emotion_window.attempts + 1 ELSE 1 END,
  failure_history  = CASE WHEN room_emotion_window.state = 'failed'
                          THEN room_emotion_window.failure_history || jsonb_build_array(jsonb_build_object(
                                 'attempt', room_emotion_window.attempts, 'diarize_run_id', room_emotion_window.diarize_run_id,
                                 'error', room_emotion_window.error, 'scored_at', room_emotion_window.scored_at))
                          ELSE room_emotion_window.failure_history END,
  diarize_run_id   = EXCLUDED.diarize_run_id
WHERE room_emotion_window.state = 'failed'
   OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
   OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
       room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed)
      IS DISTINCT FROM
      (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
       EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed)
```

**7.3 `finishEmotionWindow`.** The FIX2 statement is unchanged except that its conflict `WHERE` is now the same three-arm guard as 7.2, just before `RETURNING state`:
```sql
  WHERE room_emotion_window.state = 'failed'
     OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
     OR (room_emotion_window.state, room_emotion_window.error, room_emotion_window.segments_planned,
         room_emotion_window.segments_scored, room_emotion_window.segments_skipped, room_emotion_window.segments_failed)
        IS DISTINCT FROM
        (EXCLUDED.state, EXCLUDED.error, EXCLUDED.segments_planned,
         EXCLUDED.segments_scored, EXCLUDED.segments_skipped, EXCLUDED.segments_failed)
  RETURNING state
```
All three statements ran through bound parameters on postgres:16 (`s1-pg.ts`). 7.2 and 7.3 also ran through `pg-harness.ts` (`c2-e2e-runner`).

## 8. Flags

**F1 — C15.1 needed no edit.** Both id-shaped tokens in the tracked scratch notes are already allowlisted synthetic ids (§4). Nothing replaced, nothing allowlisted.

**F2 — the C9 guard keeps the `failed` arm. The ruling's premise here is inaccurate.**
- The ruling says *"The job runner keeps its own attempt counter, so no retry ceiling depends on the window's."* But `lib/emotion/enqueue.ts:63` retries a failed window only `WHERE … e.state = 'failed' AND e.attempts < ${EMOTION_MAX_ATTEMPTS}`, where `e.attempts` is `room_emotion_window.attempts`.
- Under a strict "write iff changed" rule, a retry that fails the same way derives an identical row, writes nothing, and never increments `attempts`, so the bound would never be reached.
- So a stored `failed` row is always rewritten, as before. A settled `ok` / `no_segments` row is rewritten only when what the rows derive differs.
- The test "a FAILED window retried to the same failure still writes" pins this, and so does `c2-e2e-runner`'s SERVICE DOWN (attempts 3, history 2). Removing the arm fails a test (§6).
- This keeps the goal (no stale row) and the ruling's accepted cost (an identical re-run of a settled `ok` window moves neither `attempts` nor `scored_at`).

**F3 — `tests/support/pg-harness.ts` has the harness bug C12 fixed in `s1-pg.ts`.** It splits any statement starting with `WITH` at its last top-level `SELECT`, so `WITH … INSERT … SELECT` fails there although Neon runs it. I worked around it by reshaping my statement (§2), not by editing the harness, which is outside the contract. Any future statement of that shape tested through `c2-e2e-runner` will fail the same way.

**F4 — `calls` is still a remembered number.** On both `finish()` and `fail("rows")`, `calls` (service calls made) comes from progress, because no row records it. `segments_planned` is the plan (accepted G4). Only scored, failed and skipped are row counts. On `fail("none")`, `calls` is NULL too.

**F5 — C10 on a pre-delete failure of a settled window.**
- Case: a re-run of a settled `ok` window whose `/health` fails.
- What it records: the window `failed` with NULL counts, which is a change, so it writes.
- What it leaves: the previous attempt's `scored` segment rows in place, because the delete had not run yet.
- The window row says failed over rows that say scored. That is the honest record of this attempt; the rows are the earlier attempt's, and the next successful attempt replaces both.
- Ruled as C10 (null before the delete); flagged because it looks like the stale shape at a glance.

**F6 — bus documents deliberately left untracked.** FIX3b §5 doesn't name them, so they stay untracked:
- the halted FIX3 kickoff and the round-3 rulings;
- the M2, M3, M4 and M5 reports and kickoffs present in the folder;
- both S1 Refuter briefs;
- the Slice E files.

**F7 — seeding in the emotion tests.** Fixture inserts use `pg.exec` with literal SQL; the code under test always goes through bound parameters. Window ids are unique per case, and the only shared row is the `sess_1` session.

**G11 (Round 3) — the seventh Vercel cron is still an open watch.** `vercel.json` is untouched.

## 9. Manual steps for V

No migration this round. The step for 0091 and 0092 is as ruled in round 4 §4, run out of clinic hours; the env var is named only:
```
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0091_disable_gemini_stt_engine.sql
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0092_bench_window_auto_drain_refusal.sql
```
**Flag on that step (F8), not verified here.** With `psql`, each `-c` and `-f` runs in turn in one session, so `SET lock_timeout` applies to the file that follows. `ON_ERROR_STOP` with a lock timeout fails the file, and both files are idempotent. It is worth one dry run against a non-production database to confirm the timeout takes effect.

## 10. Subagents

None. The reads, the gate, both mutation batches (43 mutations), the reversed-order run and the guard scans were done in this session. The only question to V was the "Guard vs docs" one, answered by the addendum.
