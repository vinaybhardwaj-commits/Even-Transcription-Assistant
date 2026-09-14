# ETA — S1 FIX2 — REPORT
**14 September 2026 · Builder · branch `vinay/s1-auto-drain` · one new commit on `d852127` · not pushed**

## 1. Commit

One new commit on top of `d852127f8727b8c4d6392e6ae404cfd84ef0ed39`. `d852127` was not amended. Nothing was pushed, and `main` was not touched. This report is inside that commit, so it cannot name the commit's own SHA. The SHA is printed in the terminal with this report, and `git log -1 --format=%H -- docs/handoff/ETA-S1-FIX2-REPORT-14-SEP-2026.md` returns it.

Pre-flight passed:
- `git rev-parse --abbrev-ref HEAD` returned `vinay/s1-auto-drain`.
- `git rev-parse HEAD` returned `d852127f8727b8c4d6392e6ae404cfd84ef0ed39`.
- `git status --porcelain | grep -v '^??'` was empty.

Per the order, I did not redo the FIX1 §4 premise checks.

## 2. Gate

Each line is quoted from the run.
- `npx tsc --noEmit` — no output; `tsc exit 0`
- `npm test` (runs `tsc --noEmit -p tsconfig.tests.json`, then `vitest run`) — ` Test Files  106 passed (106)` · `      Tests  2565 passed (2565)` · `npm test exit 0`. No test was skipped. Docker was up, so all four real-Postgres suites ran: `c2-e2e-runner` and the three S1 suites.
  - `c2-e2e-runner`'s C3 emotion tests, IDEMPOTENT included, pass against the changed `finish()` without being edited.
- `npm run build` — ` ✓ Compiled successfully in 3.2s` · `build exit 0` (not in the kickoff's gate; run because the repo `CLAUDE.md` requires it).
- `npm run check:silent` — `Found 9 silent-failure handler(s)` · `check:silent exit 1`. These are the 9 findings accepted at `1193083`; none is in a file this round touched.
- Swift — not run; out of scope per the kickoff.

The mutation run below changed source files temporarily. Every mutated file was compared byte-for-byte against a backup taken after the gate ran (`RESTORED` printed for both batches), so the gate results apply to the committed tree.

## 3. Mutation check — 38 of 38 removals failed a test

Each rule was removed or altered in turn and its test file rerun. Every mutation turned it red. The number is how many tests failed.

**Environment reads (the extension the rulings require) — 11 of 11:**
- env name misspelt: `AUTO_DRAIN_BATCH_LIMIT` 3 · `AUTO_DRAIN_MAX_AGE_HOURS` 3 · `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` 3 · `ROOM_AUTO_DRAIN_ENABLED` 29
- default changed: batch 1→2: 1 · max age 6→7: 1 · cooldown 60→61: 1
- clamp bound changed: cooldown min 5→1: 1 · cooldown max 1440→9999: 1 · max-age max 48→99: 1 · batch max 10→99: 1

**SQL hard-coding (the class N4 named) — 2 of 2:** cooldown parameter replaced by `60::int`: 1 · max age replaced by `6::int`: 1.

**C1 — 1 of 1:** `enqueueSubject` call removed: 3.

**C2 — 6 of 6:**
- `opts.actor` ignored: 3
- actor pre-check removed: 1
- POST passes no admin actor: 1
- `isUsableActor` refusal removed: 1
- POST accepts `MIGRATION_SECRET` under an invented label: 1
- (the "crossed actor" case is counted in the pre-check line above)

**C3 — 1 of 1:** `join_service_not_configured` clause removed: 1.

**C4 — 2 of 2:** UPDATE aimed at the wrong row: 1 · wrong `schema_migrations` version: 1.

**C5 — 6 of 6:**
- window-as-unit delete removed: 2
- job outcome decided from memory (`p.scored`): 2
- zero rule removed from the SQL: 4
- counts not taken from rows: 5
- scored counted as failed: 5
- window error literal changed: 2

**C6 — 6 of 6:**
- refusal not set: 3
- refusal not cleared: 3
- cooldown clause removed: 4
- migration's `IF NOT EXISTS` removed: 1
- migration column type changed: 1
- (the hard-coded cooldown above is also C6)

**S1 rules re-run — 5 of 5:** order `ASC`: 2 · grid clause: 1 · `room_day` clause: 1 · live-job status: 1 · flag ignored: 6.

## 4. Files

`git diff --stat d852127` for code and tests:
```
 app/api/admin/drain-windows/route.ts               |  67 ++-
 db/migrations/0091_disable_gemini_stt_engine.sql   |  32 ++
 .../0092_bench_window_auto_drain_refusal.sql       |  30 ++
 lib/emotion/store.ts                               | 103 ++++-
 lib/jobs/kinds/emotion-window.ts                   |  27 +-
 lib/stt/auto-drain.ts                              |  71 ++-
 tests/support/s1-pg.ts                             | 107 +++++
 tests/unit/s1-auto-drain.test.ts                   | 506 +++++++++++++++------
 tests/unit/s1-emotion-zero-scored.test.ts          | 232 +++++++---
 tests/unit/s1-fix2-migrations.test.ts              |  76 ++++
 10 files changed, 997 insertions(+), 254 deletions(-)
```

The same commit adds these 13 bus documents, staged by exact filename:
- `ETA-S1-AUTO-DRAIN-CC-KICKOFF-14-SEP-2026.md`
- `ETA-S1-AUTO-DRAIN-REPORT-14-SEP-2026.md`
- `ETA-S1-D1-VERDICT-AND-RULINGS-14-SEP-2026.md`
- `ETA-S1-FIX1-CC-KICKOFF-14-SEP-2026.md`
- `ETA-S1-FIX1-REPORT-14-SEP-2026.md`
- `ETA-S1-FIX2-CC-KICKOFF-14-SEP-2026.md`
- `ETA-S1-ROUND2-RULINGS-14-SEP-2026.md`
- `ETA-D1-HEALTH-PROBES-DEBUG-BRIEF-14-SEP-2026.md`
- `ETA-D1-HEALTH-PROBES-ROOTCAUSE-14-SEP-2026.md`
- `ETA-M1-MINI-EVENT-LOOP-CC-KICKOFF-14-SEP-2026.md`
- `ETA-M1-MINI-EVENT-LOOP-REPORT-14-SEP-2026.md`
- `ETA-S1-REFUTER-VERDICT-14-SEP-2026.md`
- this report

Nothing on the untouched list moved: `git diff --name-only d852127` over `lib/stt/room-drain.ts`, `lib/bench-window.ts`, `lib/stt/fanout.ts`, `lib/emotion/enqueue.ts`, `lib/emotion/client.ts`, `lib/mcp`, `lib/stt/adapters`, `lib/jobs/runner.ts`, `lib/jobs/store.ts`, `lib/jobs/submit.ts`, `vercel.json`, `apps` and `package.json` printed 0 lines. `tests/support/pg-harness.ts` and `c2-e2e-runner.test.ts` are untouched too.

What each change does:
- **C1** — `auto-drain.ts` calls `enqueueSubject("bench_window", id, "asr")` before `drainRoomWindow`.
- **C2** — `enqueueAutoDrain(origin, { actor? })` defaults to `SYSTEM_ACTOR` / `"cron"`, and refuses an unusable actor as a batch before any read. GET passes nothing. POST resolves the admin id with `guard()`, copied verbatim from `bench/drain`, including `admin_id_missing_from_token`, and passes `{ actor: adminId, via: "admin_route" }`. A POST without a valid admin cookie gets `AUTH_REQUIRED`: *"a manual drain records spend against a person and requires a signed-in admin — a secret is not accepted on POST; the scheduled door is GET"*. No actor string is invented.
- **C3** — the route returns 500 when a result is `join_failed` with `detail === "join_service_not_configured"`. To make that possible, `results[]` gained an optional `detail`.
- **C4** — migration `0091`.
- **C5** — new `clearWindowSegments` and `finishEmotionWindow` in `lib/emotion/store.ts`. `prepare` deletes the window's segment rows after planning succeeds and before its first write. `finish()` makes one statement that counts the rows, applies the zero-scored rule once in SQL, and writes the window. The `no_segments` path is unchanged.
- **C6** — migration `0092`; the selector's cooldown clause; the set and clear UPDATEs; `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` via `clampedIntEnv(…, 60, 5, 1440)`.
- **C7** — tests:
  - Env names are written literally in the tests.
  - All three tunables run at non-default values (3, 2, 15), with fixtures derived from the value the test set, plus a check that the fixture falls inside the default so the test proves something.
  - Every clamp bound is tested.
  - The POST cookie door succeeds in a test.
  - `seedScrambled` derives its ages from `AUTO_DRAIN_MAX_AGE_HOURS`.
  - All real-Postgres SQL goes through bound parameters via `tests/support/s1-pg.ts`.

## 5. SQL — every string verbatim. All INFERRED against the migrations; none has run against the live database

**5.1 The selector** (`lib/stt/auto-drain.ts`). `${…}` are bound parameters.
```sql
SELECT w.id
  FROM bench_window w
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

**5.2 The legacy row** — existing SQL in `lib/stt/fanout.ts:56`, now called by the auto-drain:
```sql
INSERT INTO stt_subject_job (subject_type, subject_id, tier, state)
VALUES (${subjectType}, ${subjectId}, ${tier}, 'queued')
ON CONFLICT (subject_type, subject_id, tier) DO NOTHING
```

**5.3 Refusal set and clear** (`lib/stt/auto-drain.ts`):
```sql
UPDATE bench_window SET auto_drain_refused_at = NULL, auto_drain_refused_reason = NULL WHERE id = ${w.id}
UPDATE bench_window SET auto_drain_refused_at = NOW(), auto_drain_refused_reason = ${out.step} WHERE id = ${w.id}
```

**5.4 Window-as-unit delete** (`lib/emotion/store.ts`):
```sql
DELETE FROM room_span_emotion WHERE window_id = ${windowId}
```

**5.5 The finishing write** (`lib/emotion/store.ts`, `finishEmotionWindow`):
```sql
WITH seg AS (
  SELECT count(*) FILTER (WHERE state = 'scored')::int  AS scored,
         count(*) FILTER (WHERE state = 'failed')::int  AS failed,
         count(*) FILTER (WHERE state = 'skipped')::int AS skipped
    FROM room_span_emotion
   WHERE window_id = ${f.windowId}::text AND diarize_run_id = ${f.diarizeRunId}::text
),
-- THE RULE, ONCE: segments were planned and none of the persisted rows is scored.
v AS (SELECT seg.*, (${f.planned}::int > 0 AND seg.scored = 0) AS zero_scored FROM seg),
rec AS (
  INSERT INTO room_emotion_window
    (window_id, room_day_id, state, diarize_run_id, error, model, model_key, subfolder, cap_s,
     segments_planned, segments_scored, segments_skipped, segments_failed, calls, warmup_json, timing_json, scored_at)
  SELECT ${f.windowId}::text, ${f.roomDayId}::text,
         CASE WHEN v.zero_scored THEN 'failed' ELSE 'ok' END,
         ${f.diarizeRunId}::text,
         CASE WHEN v.zero_scored THEN 'emotion_zero_scored' ELSE NULL END,
         ${f.model}::text, ${f.model_key}::text, ${f.subfolder}::text, ${f.cap_s}::double precision,
         ${f.planned}::int, v.scored, v.skipped, v.failed, ${f.calls}::int,
         ${f.warmup === undefined ? null : JSON.stringify(f.warmup)}::jsonb, ${f.timing === undefined ? null : JSON.stringify(f.timing)}::jsonb, NOW()
    FROM v
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
  WHERE room_emotion_window.state = 'failed' OR room_emotion_window.diarize_run_id <> EXCLUDED.diarize_run_id
  RETURNING state
)
SELECT v.scored, v.failed, v.skipped, v.zero_scored, (SELECT state FROM rec) AS written_state FROM v
```
Two things to check about this statement:
- Postgres only allows a data-modifying CTE at the top level, and Neon's HTTP driver sends the statement as written. The test harness keeps it at the top level, as the app does.
- Every parameter is cast explicitly, because `INSERT … SELECT` does not infer a parameter's type from the target column.

It ran through PREPARE/EXECUTE with untyped string parameters on postgres:16, with 0089 verbatim.

**5.6 Migration 0091** (statements; the header comment is in the file):
```sql
UPDATE stt_engine
   SET enabled = false
 WHERE id = 'gemini'
   AND enabled = true;

INSERT INTO schema_migrations (version, name)
VALUES (91, '0091_disable_gemini_stt_engine')
ON CONFLICT DO NOTHING;
```

**5.7 Migration 0092:**
```sql
ALTER TABLE bench_window ADD COLUMN IF NOT EXISTS auto_drain_refused_at timestamptz NULL;
ALTER TABLE bench_window ADD COLUMN IF NOT EXISTS auto_drain_refused_reason text NULL;

INSERT INTO schema_migrations (version, name)
VALUES (92, '0092_bench_window_auto_drain_refusal')
ON CONFLICT DO NOTHING;
```

Both migrations were applied verbatim twice to postgres:16 (0091 on top of 0018 + 0073). Neither errored, the second run changed nothing, and each recorded its version exactly once.

## 6. Flags

**G1 — C1 changes what the room card counts as "waiting".**
- `countRoomWaitingWindows` and `drainRoomWaitingWindows` (`room-drain.ts:1269-1329`) count and run closed windows with *no* `stt_subject_job` row.
- The auto-drain now creates that row for every window it offers, including windows in a Transcript-off room. For those, `drainRoomWindow` returns `flag_off` before its claim, so the row stays `queued` with 0 attempts.
- Once the flag is on:
  - a Transcript-off room's "N waiting" count falls as the cron reaches its windows;
  - those windows move into `drainQueuedRoomWindows`' queue instead;
  - the "run this room's waiting audio" control stops seeing them.
- This follows from the ruling as written. It is flagged because it changes an operator-visible number.

**G2 — a manual re-run of a settled emotion window can leave the rows and the window row disagreeing.** The enqueue scan never picks such a window; only a manual `scribe_job_submit` reaches this case.
- The case: the window row is final (`ok` or `no_segments`) for the same diarize run, and a job runs again.
- `prepare` still deletes and rewrites the segment rows, as C5 orders. The conditional upsert then leaves the final window row as it is; `finish()` returns `window_row: "left_final"`.
- If that re-run scores everything, rows and window agree. `c2-e2e-runner`'s IDEMPOTENT test, which this build does not edit, passes because of that.
- If the re-run scores nothing, the job fails `emotion_zero_scored`, the segment rows say `failed`, and the window row still says `ok`.
- A ruling is needed: either skip the delete when the window row is final for the same run, or let `finish()` replace a final row.

**G3 — failure paths still record counts from memory.** C5.2 names `finish()`. `fail()`, used by `warm`/`score` on a service or cap failure, still records `p.scored`/`p.failed` from progress. Those are partial counts on a failed row; the kickoff did not name them, so they are unchanged.

**G4 — `segments_planned` is the plan, not a row count.** It is `p.segments.length`. `scored`, `failed` and `skipped` are counted from rows. A segment write lost inside an attempt would therefore show up as `planned > scored + failed` and be recorded as it is, not refused.

**G5 — the delete is its own statement,** separate from the writes that follow. A crash between them leaves the window with no segment rows and the previous window row in place; the retry bound governs the next attempt.

**G6 — the route response's failure message now includes `step:detail`.**
- That detail is `drainRoomWindow`'s `detail` string. For `engine_failed` it is an exception message of up to 200 characters.
- The route is reachable only with the cron or migration secret, or as a signed-in admin.
- `bench/drain` already returns the drain's full outcome to admins.

**G7 — an unusable actor is refused before any read, as one batch failure (HTTP 500),** not as a `no_actor` result per window. This matches `drainRoomWaitingWindows`, which also refuses a whole batch that has no usable actor.

**G8 — refusal writes happen after each drain.** If the refusal or clear UPDATE throws, the call returns 500 even though the drain may already have submitted its job. On the next tick the live-job clause stops a second submit.

**G9 — a new test support file, `tests/support/s1-pg.ts`.** It uses bound parameters and one container name per suite. Writing it surfaced a real difference: Neon sends a JS array as a Postgres array literal. `room-drain`'s `state = ANY(${drainable}::text[])` failed under a JSON-encoded array until the harness matched the driver. The inlining harness would never have shown that. `pg-harness.ts` is unchanged.

**G10 — bus documents.**
- Committed: the 13 named in §3 of the kickoff.
- Left untracked because the kickoff does not name them: `ETA-S1-REFUTER-BRIEF-14-SEP-2026.md`, `ETA-M2-ROUTER-MEASUREMENT-CC-KICKOFF-14-SEP-2026.md`, both Slice E files, and `docs/handoff/scratch/*`.
- Before staging, I scanned the 12 pre-existing documents for identifier shapes: `doc_<id>`, uhid, member id, session/window/room-day ids, `Dr <Name>`, 10-digit runs, emails, name fields. Only matched shapes were printed, never text. One file had 4 hits, all `.py.bak-YYYYMMDDHHMMSS` rollback-file suffixes in the M1 report. Nothing else matched.

**G11 — still open, not touched this round.** F6, the seventh Vercel cron, remains a watch on the preview deploy; `vercel.json` is unchanged. Per the rulings, `ROOM_AUTO_DRAIN_ENABLED` stays off pending the Refuter's PASS, this fix merged, and order M2's measurement of `route`.

## 7. Manual steps for V

Apply both migrations to the production database. The env var is named only; its value is never read here:
```
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0091_disable_gemini_stt_engine.sql
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0092_bench_window_auto_drain_refusal.sql
```
- **0092 must be applied before `ROOM_AUTO_DRAIN_ENABLED` is set.** The selector reads the new columns. While the flag is off, the route returns before any query, so deploying the code ahead of 0092 is safe.
- **0091 is independent.** Its effect can be read afterwards through `scribe_health`, where `gemini` should no longer count.

`AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` is optional; leave it unset for 60.

## 8. Subagents

None. I did the reads, the build, the gate, both mutation batches (38 mutations) and the identifier scan in this session.
