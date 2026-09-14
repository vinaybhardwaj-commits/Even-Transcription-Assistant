# ETA — SLICE S1: THE AUTO-DRAIN + THE ZERO-SCORED EMOTION WINDOW — REPORT
**14 September 2026 · Builder · branch `vinay/s1-auto-drain` · not pushed**

## 1. Commit

`d852127f8727b8c4d6392e6ae404cfd84ef0ed39` on `vinay/s1-auto-drain`, one commit on top of `vinay/release-b1` at `14a4f386c16e68a611913c470585103d0171fe32`. Not pushed. `main` was not touched.

Pre-flight: `pwd` was the repo. `origin` was the named GitHub URL. `git rev-parse origin/vinay/release-b1` returned `14a4f386…`. `git status --porcelain | grep -v '^??'` was empty. After `git checkout vinay/release-b1`, `HEAD` was `14a4f386…`. The worktree had been on `vinay/tier2-c3`, as the kickoff said. The only untracked files were under `docs/handoff/`, and I left them alone.

## 2. Gate

Each line is quoted from the run on the committed tree.

- `npx tsc --noEmit` — no output; `tsc exit 0`
- `npm test` (runs `tsc --noEmit -p tsconfig.tests.json`, then `vitest run`) — ` Test Files  105 passed (105)` · `      Tests  2535 passed (2535)` · `npm test exit 0`. No tests were skipped. Docker was available, so both real-Postgres suites ran: `c2-e2e-runner` and the new selector suite.
  - ` ✓ tests/unit/s1-auto-drain.test.ts (24 tests) 5335ms`
  - ` ✓ tests/unit/s1-emotion-zero-scored.test.ts (4 tests) 2ms`
- `npm run build` — ` ✓ Compiled successfully in 3.0s` · `build exit 0`. The route list includes `ƒ /api/admin/drain-windows`.
- `npm run check:silent` — `Found 9 silent-failure handler(s)` · `check:silent exit 1`. These are the 9 findings accepted as pre-existing at `1193083`: 3 files under `app/[slug]/…`, none of them mine. No new finding.
- `swift build` / `swift test` — **not run**. The kickoff §8 puts them out of scope, and `apps/` is untouched.

Self-check, not a verdict: I mutated each new rule in the source and reran the matching test file. Every mutation turned it red, and both source files were then restored byte-for-byte:
- `closed_at DESC`→`ASC`: 2 failed
- `grid_aligned` clause removed: 1 failed
- `room_day_id` clause removed: 1 failed
- age clause removed: 1 failed
- live-job `status` clause removed: 1 failed
- flag check bypassed: 6 failed
- emotion rule reverted: 1 failed
- emotion rule changed to "any failure": 1 failed

## 3. Files changed

`git show --stat HEAD`:
```
 app/api/admin/drain-windows/route.ts      |  89 +++++++
 lib/jobs/kinds/emotion-window.ts          |   7 +-
 lib/stt/auto-drain.ts                     | 109 +++++++++
 tests/unit/s1-auto-drain.test.ts          | 383 ++++++++++++++++++++++++++++++
 tests/unit/s1-emotion-zero-scored.test.ts |  90 +++++++
 vercel.json                               |   4 +
 6 files changed, 681 insertions(+), 1 deletion(-)
```
`git diff --name-only vinay/release-b1..HEAD` lists exactly these six files. Nothing outside the contract moved. Running `git diff --name-only vinay/release-b1..HEAD --` over the UNTOUCHED list printed 0 lines. That list is `lib/stt/room-drain.ts`, `lib/bench-window.ts`, `lib/jobs/runner.ts`, `lib/jobs/store.ts`, `lib/jobs/submit.ts`, `lib/stt/adapters/route.ts`, `lib/mcp`, `db/migrations`, `apps`, `package.json`, `lib/stt/registry.ts` and `docs/handoff`. There is no migration. No OpenSpec folder exists in this repo.

What each change does:
- `lib/stt/auto-drain.ts` exports `enqueueAutoDrain(origin, opts?)` → `{enqueued, considered, results[{window_id, step, job_id?}]}`. It also exports `AUTO_DRAIN_BATCH_LIMIT` (default 1, clamp 1..10), `AUTO_DRAIN_MAX_AGE_HOURS` (default 6, clamp 1..48), the pure resolver `clampedIntEnv`, and `ROOM_AUTO_DRAIN_ENABLED_ENV`. The flag is read with `parseFlag`. Every window goes to `drainRoomWindow(id, origin, { actor: SYSTEM_ACTOR, via: "cron" })`. `enqueued` counts results whose step is `"enqueued"`.
- `app/api/admin/drain-windows/route.ts` copies the auth from `diarize-windows`: GET takes Bearer `CRON_SECRET` or `MIGRATION_SECRET`; POST takes the admin cookie or Bearer `MIGRATION_SECRET`. `?limit` is honoured only downward, capped at `AUTO_DRAIN_BATCH_LIMIT`.
- `lib/jobs/kinds/emotion-window.ts` changes `finish()` only. When `segments.length > 0 && scored === 0`, the window is recorded `state: "failed"`, `error: "emotion_zero_scored"`, and the job fails. The `scored > 0` case is unchanged (`ok`). The `planned = 0` case is unchanged; it is still `prepare`'s `no_segments` path.
- `vercel.json` gains `{"path":"/api/admin/drain-windows","schedule":"*/5 * * * *"}`, making 7 crons.

## 4. SQL and external-schema assumptions — ALL INFERRED

**The selector** (`lib/stt/auto-drain.ts`), verbatim. `${…}` are bound parameters: `AUTO_DRAIN_MAX_AGE_HOURS` (int), `ROOM_WINDOW_KIND` (= `'room_window'`) and the clamped limit (int).
```sql
SELECT w.id
  FROM bench_window w
 WHERE w.state = 'closed'
   AND w.grid_aligned = TRUE
   AND w.room_day_id IS NOT NULL
   AND w.closed_at >= NOW() - (${AUTO_DRAIN_MAX_AGE_HOURS}::int * INTERVAL '1 hour')
   AND NOT EXISTS (
     SELECT 1 FROM scribe_job j
      WHERE j.kind = ${ROOM_WINDOW_KIND}
        AND j.args->>'window_id' = w.id
        AND j.status IN ('queued', 'running')
   )
 ORDER BY w.closed_at DESC
 LIMIT ${limit}
```
Where each assumption comes from:
- `bench_window.state`, `grid_aligned`, `room_day_id`, `closed_at` (timestamptz): `db/migrations/0057_bench_window.sql`. `closed_at` is set by `UPDATE … SET state = 'closed', closed_at = NOW()` at `lib/bench-window.ts:379`.
- `scribe_job.kind`, `args` (jsonb), `status` CHECK `('queued','running','done','failed','cancelled')`: `db/migrations/0082_scribe_job.sql`.
- **Live-job detection** is `args->>'window_id'`. `drainRoomWindow` submits `args: { window_id: windowId, origin, actor, via }` (`lib/stt/room-drain.ts:505`), and `enqueueDiarizeWindows` already uses this same clause for `diarize_window`. It was determined from source; I did not guess it. **Please validate live:** run `SELECT count(*) FROM scribe_job WHERE kind = 'room_window' AND args ? 'window_id'` and compare with `count(*) … WHERE kind = 'room_window'`.
- The idiom `${n}::int * INTERVAL '1 hour'` is the one `lib/bench-commands.ts:495` and `lib/room-auth.ts:186` already use.
- The selector ran against real postgres:16 with 0057 and 0082 applied verbatim. The only extra was a one-column `bench_session` stub for 0057's foreign key. That proves the SQL parses and filters as intended on that DDL, not on production data.

The emotion change adds no SQL. It calls the existing `recordEmotionWindow` with `state: "failed"`, and 0089's `room_emotion_window` already accepts that state, because `fail()` writes it today.

## 5. Deviations and flags

**F1 — A failed window with no `stt_subject_job` row is re-offered on every tick, for up to 6 hours. This is the one to rule on.**
The retry bound on the room path is `stt_subject_job.attempts`. `recordFailure` (`room-drain.ts:398`) increments it, then parks the window `failed` at `DRAIN_MAX_ATTEMPTS = 3`. Otherwise it puts the window back to `closed`. If the window has no legacy row, the UPDATE matches nothing and `attempts` comes back 0. The window returns to `closed` and never parks. That happens when a window closed while the room's Transcript switch was off and the switch was turned on later, because `bench-window.ts:397` only inserts the row when Transcript is on. The auto-drain would then offer such a window every five minutes until `closed_at` ages past `AUTO_DRAIN_MAX_AGE_HOURS`: up to 72 attempts, each a job, and possibly a paid engine call.
- Windows that do have the legacy row are bounded at 3, re-offered 5 minutes apart.
- I did not change the selector. The kickoff settles its predicate, and adding a `stt_subject_job` clause would be a design decision.
- Options for the Orchestrator:
  - (a) add `AND EXISTS (SELECT 1 FROM stt_subject_job j WHERE j.subject_type='bench_window' AND j.subject_id=w.id AND j.tier='asr' AND j.state='queued' AND j.attempts < DRAIN_MAX_ATTEMPTS)`. This mirrors `drainQueuedRoomWindows`, but it would also skip windows that have no row.
  - (b) call `enqueueSubject` before `drainRoomWindow`, as `drainRoomWaitingWindows` does, so the bound always has a row to count on.
  - (c) accept the 6-hour bound.

**F2 — The job error code is `emotion_window_failed`, not a new code.** `emotion_zero_scored` is not in `JOB_ERROR_CODES` (`lib/jobs/errors.ts`), and `jobError` only accepts published codes. That file is outside the contract. So:
- The window row's `error` is exactly `"emotion_zero_scored"`, as the kickoff says.
- The job row's `error` is `emotion_window_failed: emotion_zero_scored: <failed> of <planned> segment(s) failed`.
- A read-scope caller sees `emotion_window_failed` only. The specific reason is on the window row and in invoke-scope detail.
- If a dedicated code is wanted, it is a one-line addition to `JOB_ERROR_CODES` in a later order.

Also note: this row's `error` is the bare literal. The kind's other failures write `<code>: <detail>` through `fail()`.

**F3 — POST (the manual door) also runs as `SYSTEM_ACTOR` via `cron`.** The kickoff's signature `enqueueAutoDrain(origin, opts?)` has no actor, and D-S1.2 names `SYSTEM_ACTOR`. So a person who presses POST is filed in the ledger as the cron. `diarize-windows` gives its two verbs different actors, and `receipt.ts` describes `system:cron` as a value "only an UNATTENDED path may pass". Rule on whether POST should take the admin id with `via: "admin_route"`, which would change the signature.

**F4 — Which per-window steps make the route answer `PIPELINE_FAILED`.** I followed the template's principle that a failed enqueue must not look like success, and applied it narrowly:
- `no_actor` and `engine_failed` (the drain could not submit) → HTTP 500.
- Every other step (`flag_off`, `wrong_state`, `no_room_day`, `too_long`, `join_failed`, `not_found`) → 200, with the step named in `results`.
- One of those is really a configuration failure: `join_failed` with detail `join_service_not_configured`. It returns 200 today.
- A bad flag value or a scan that throws → 500.

**F5 — Integer env parsing.** An unset, empty or non-integer value for `AUTO_DRAIN_BATCH_LIMIT` or `AUTO_DRAIN_MAX_AGE_HOURS` (`"abc"`, `"2.5"`, `"4h"`) silently takes the default. It does not throw, unlike `parseFlag`. Out-of-range integers are clamped. Both constants are resolved once, at module load.

**F6 — Vercel's cron count cannot be checked here.** `vercel.json` now has 7 crons. `next build` does not validate crons, so the local green build proves nothing about a platform limit. The deploy is the check: if the preview build refuses the seventh cron, that is the stop the kickoff names.

**F7 — The selector test has its own Postgres container.** `tests/support/pg-harness.ts` hard-codes the container name `eta-c2-e2e`, and vitest runs files in parallel, so a second user of the harness would `docker rm -f` the other suite's database. Parametrising the harness was outside the contract. The new test therefore holds a short local copy of the start/psql logic, under the container name `eta-s1-auto-drain`. It keeps the repo's REQUIRED PROOF rule: without Docker the suite fails unless `ETA_ALLOW_SKIP_E2E=1`. It uses 0057 and 0082 verbatim.

**F8 — The kickoff file was not committed.** The repo `CLAUDE.md` says kickoffs are committed with the work. This kickoff's §1 and §5 say files under `docs/handoff/` are to be left alone and are not in the file contract, and the global rules forbid committing bus documents. I followed the kickoff: `ETA-S1-AUTO-DRAIN-CC-KICKOFF-14-SEP-2026.md` and this report stay untracked.

**F9 — Testing notes.**
- Property 2 is shown on one row: refused, then offered after an UPDATE of only the field under test (age, `grid_aligned`, `room_day_id`). Beyond the kickoff's list, the same file also checks non-`closed` states and a live `room_window` job. A finished job, or a job of another kind, does not exclude.
- The cap and order are tested twice. First at the shipped cap, with `AUTO_DRAIN_BATCH_LIMIT + 2` rows. Then again with `AUTO_DRAIN_BATCH_LIMIT=3` from the environment, so the full `closed_at DESC` ordering is visible. The rows are inserted in an order where neither insertion order nor `start_ms` order gives the expected answer.
- Age fixtures are `AUTO_DRAIN_MAX_AGE_HOURS * 60 ± 5` minutes (rule 10).

## 6. Manual steps for V

- No migration.
- To turn the cron on after merge, set `ROOM_AUTO_DRAIN_ENABLED` in the Vercel production environment. Unset, the cron is a no-op returning `enqueued: 0`.
- Optional: `AUTO_DRAIN_BATCH_LIMIT` and `AUTO_DRAIN_MAX_AGE_HOURS`. Leave them unset to keep 1 and 6.
- The cron needs `CRON_SECRET`, which the existing crons already use.
- Rule on F1 before setting the flag.

## 7. Subagents

None used. The grounding reads, the build, the tests and the mutation self-check were done in this session.
