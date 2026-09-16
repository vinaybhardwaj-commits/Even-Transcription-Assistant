# ETA-E31 — R63 and R64 · BUILDER REPORT · 16 Sep 2026

Worktree `Even-Transcription-Assistant-e31b`, branch `vinay/e31-atomicity-b`, base `2cfbbe7`. Not pushed.

## 1. Commits

- `1c5d32b` — E31 R63: an unrecorded FAILURE is refused; an unrecorded SUCCESS is not punished
- `9aabfe3` — E31 R64: the pin-reset audit row follows the live audit_log convention

## 2. Gate, run at `9aabfe3`, Docker up, no exclusions

- `npm run typecheck` — exit 0
- `npm test` — exit 0 (runs `typecheck:tests` then vitest): `Test Files  115 passed (115)`, `Tests  2793 passed (2793)`
- `npm run build` — exit 0
- `npm run check:silent` — `Found 9 silent-failure handler(s)`. These are the 9 accepted findings. None is in a file this work touched.
- No Swift (R30/R27).

At `1c5d32b` the same gate gave: typecheck 0, 115 files and 2792 tests passed, build 0, check:silent the accepted 9.

## 3. Files changed

`git diff --stat 2cfbbe7 9aabfe3`:
```
 app/api/auth/pin/route.ts         |  23 +++---
 lib/lockout.ts                    |  83 ++++++++++++++-----
 tests/unit/e31b-atomicity.test.ts | 162 ++++++++++++++++++++++++++++++++------
 3 files changed, 218 insertions(+), 50 deletions(-)
```
Nothing outside these three files changed. A4, A7 and D1 code was not touched. The D3 fixture's `clinician` table gained
`last_active_at, full_name, url_slug, pin_hash, deleted_at`. The `audit_log` fixture that D1 uses was not changed. No
migration. `-e31a` and `-e31c` were not entered. This repo has no OpenSpec change folder for this work.

## R63 — what was built

- **(a) Wrong pin, counter write does not land: REFUSED.** No change from `2cfbbe7`. `recordFailedAttempt` returns
  `not_recorded`, and the route answers `PIPELINE_FAILED` without claiming a lock or a disable.
- **(b) Correct pin, reset write does not land: the login is ALLOWED.** `recordSuccessfulAttempt` logs its own line and
  writes an audit row if `audit_log` is reachable. It returns `{kind:"reset_not_recorded", audited}`. The route logs
  `session issued with the lockout counter NOT reset` and issues the session.
- **(c) The two paths are distinguishable.** `recordSuccessfulAttempt` now returns a separate type, `ResetOutcome`, which
  has no refusal kind. The log lines are distinct exported constants: `LOG_FAILED_ATTEMPT_NOT_RECORDED` ("… refusing")
  and `LOG_RESET_NOT_RECORDED` ("… allowing the login"). Comments at both route branches say the asymmetry is deliberate.
- The commit message states the distinction: an unrecorded FAILURE must not be ignored; an unrecorded SUCCESS is not
  punished.

The tests call the real `POST` handler against postgres:16. Only `signDoctorJwt` and `setDoctorCookie` are stubbed, as
spies. A trigger makes the clinician UPDATE fail. This replaces `2cfbbe7`'s test that matched the route's source text.
Measured:
- Wrong pin at count 4: HTTP 500 `PIPELINE_FAILED` "could not be recorded". No JWT, no cookie. Row still 4, `active`,
  `locked_until` null. Only the failure log line was written.
- Wrong pin at count 29: HTTP 500, not 403. Row still 29 and `active`.
- Correct pin at count 3: HTTP 200 `ok:true`. JWT minted for this clinician, cookie set once. Row still 3 (the accepted
  stale counter). Only the reset log line was written. One audit row.
- Correct pin with `audit_log` INSERT failing as well: HTTP 200. Route line shows `"audited":false`. Zero audit rows.
- Lib level: `reset_not_recorded`/`audited:true` when the write fails; `reset` and a count of 0 when it lands. A ghost
  id (zero rows) returns `reset_not_recorded`, never `not_recorded`.

Before this, the fixture had no `last_active_at` column, so no test had ever run a reset that succeeds. The `2cfbbe7`
test "a correct pin does not authenticate" would have passed without its trigger.

## R64 — what was built

- Audit identifiers now follow the live convention. `actor_id` is `auth:pin-lockout-v1` (was `pin_lockout`). `action` is
  `auth.pin_reset_write_failed` (was `auth.pin_reset_not_recorded`). Both are constants: `AUDIT_ACTOR_PIN_LOCKOUT`,
  `AUDIT_PIN_RESET_WRITE_FAILED`.
- Flag 3 is kept. At the `pin_attempt` INSERT catch in `recordFailedAttempt`, a comment now gives the reason. The
  counter is the security-bearing record, so the lockout still bounds brute force. The rate limiter is defence in
  depth, not the bound. Refusing there would re-create lockout-during-degradation.
- New route test for flag 3: the `pin_attempt` INSERT fails and the counter lands. Result: HTTP 401 `PIN_INVALID`,
  counter 1 → 2, zero `pin_attempt` rows, no JWT.
- The R63 correct-pin route test now checks all six fields of the audit row literally.

## Mutation — 18 run, 18 caught, no equivalents

The script lives in the session scratchpad. It applies one textual mutant, runs `tests/unit/e31b-atomicity.test.ts` with
the JSON reporter, and restores the file. Baseline: 24 passed. Afterwards, a check confirmed no mutant text was left.

| Mutant | Killed by |
|---|---|
| SYM refuse-both, route (refuses `reset_not_recorded`) | both R63 (b) route tests |
| SYM allow-both, route (drops the `not_recorded` refusal) | both R63 (a) route tests |
| SYM allow-both, lib (a failed clinician write returns `ok`) | R58 write-fails, R58 limiter, both R63 (a) |
| SYM refuse-both, lib (an unrecorded reset throws) | both R63 (b), R63 lib, R63 (c) |
| Lock claimed (a failed write returns `disabled`) | R58 write-fails, R58 limiter, both R63 (a) |
| Log swap (success path logs the failure line) | R63 (b) |
| Log silent (success path does not log) | R63 (b) |
| Audit skipped | R63 (b), R63 lib |
| Audit unguarded (audit failure escapes) | R63 (b) audit down |
| Route line dropped | R63 (b) audit down |
| Reset zero rows reads as `reset` | R63 (c) |
| Reset always unrecorded | R63 lib |
| Failed-attempt zero rows reads `ok` | R58 zero rows |
| R64 actor back to bare `pin_lockout` | R63 (b) |
| R64 action back to `auth.pin_reset_not_recorded` | R63 (b) |
| R64 target_type `doctor` → `clinician` | R63 (b) |
| R64 free text added to metadata | R63 (b) |
| R64 flag 3 tightened (a lost `pin_attempt` row refuses) | R64 flag-3 test only |

## 4. SQL and external-schema assumptions

**New in R63/R64, as written at `9aabfe3` (`lib/lockout.ts`):**
```sql
INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
VALUES ('system', ${AUDIT_ACTOR_PIN_LOCKOUT}, ${AUDIT_PIN_RESET_WRITE_FAILED}, 'doctor', ${doctor.doctor_id},
        ${JSON.stringify({ reason: failure.reason, stale_failed_pin_count: doctor.failed_pin_count })}::jsonb)
RETURNING id
```
With the values filled in, the row is: `actor_type='system'`, `actor_id='auth:pin-lockout-v1'`,
`action='auth.pin_reset_write_failed'`, `target_type='doctor'`, `target_id=<doctor_id>`,
`metadata_json={"reason":"threw"|"zero_rows","stale_failed_pin_count":<int>}`. `reason` is a closed two-value code.
The metadata holds no free text, no pin and no name.

**Column names. I checked these against the repo's schema definitions. I did not check them against the live table,
because I have no database.** `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `metadata_json` and `id`
(for `RETURNING`) appear the same in three places:
- `db/migrations/0001_init.sql:188-199`. It creates `audit_log`, and no later migration alters it (grep over
  `db/migrations/`: only a comment in 0007).
- `db/schema.ts:232-243` (Drizzle).
- `lib/jobs/audit-read.ts`, which runs `SELECT … actor_id …` and maps `actor: r.actor_id`. That is why the operator view
  shows `actor`: it is a display alias, not a column.
`'system'` is a member of `actor_type AS ENUM ('admin','doctor','system')` (0001:40).

**Still INFERRED and worth checking live:** that production's column names match the repo. Query:
`SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log' ORDER BY ordinal_position;`
Also inferred: that `target_type 'doctor'` is the live convention for a clinician target. `lib/voiceprint-load.ts`
already writes it, and the Orchestrator's R64 ruling accepted it.

**Carried from `2cfbbe7`, SQL text unchanged:** the `pin_attempt` INSERT, the clinician counter UPDATE … RETURNING, and
the reset `UPDATE clinician SET failed_pin_count = 0, locked_until = NULL, last_active_at = NOW(), updated_at = NOW()
WHERE id = … RETURNING id`. The reset now relies on `clinician.last_active_at`, and `db/migrations/0001_init.sql:71`
defines it. The test fixture never had it, so the fixture was not what proved this column.

## 5. Deviations and flags

- Beyond the order's literal list, I added one test (the flag-3 route test) and one mutant for it. Without them, the
  comment R64 asked for would have nothing checking it.
- `reason` in metadata is a closed code (`threw`/`zero_rows`), not a boolean. My reading is that it fits "flags". If the
  Orchestrator wants booleans only, it is a one-line change.
- The `audit_log` fixture in the test file still uses `id bigserial` and `actor_type text`, where production has `uuid`
  and the enum. It is shared with D1, so I left it alone. The R64 test checks the row's values, not the column types.

## 6. Manual steps for V

None. No migration.

## 7. Subagents

None used.
