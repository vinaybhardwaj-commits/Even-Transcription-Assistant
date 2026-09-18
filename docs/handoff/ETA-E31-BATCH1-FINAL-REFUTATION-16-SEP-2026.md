# ETA-E31 — BATCH 1 FINAL REFUTATION · 16 Sep 2026 · Opus Refuter

Heads: `vinay/e31-atomicity-a` **`0f5fc9b`**, `vinay/e31-atomicity-b` **`9aabfe3`** (on `1c5d32b` and `2cfbbe7`), and
`vinay/e31-harness` **`b29d9af`**. All three trees were clean at start and end. I fixed nothing, committed nothing,
merged nothing and pushed nothing. Migrations ran only in ephemeral containers, now removed. No Swift.

The R62 builder report is not on the bus. The fix report file is still the R60/R61 one, so I refuted `0f5fc9b`
against its commit message.

## VERDICT

**Batch 1 is ready to merge and ship.** Every claim I was asked to attack holds when measured. Every mutant that
matters goes RED. The merged tree is green on the full gate.

**One security finding is separate from that answer, and it is not a preference.** Under a database that refuses
writes but serves reads, a PIN brute force is unbounded and ends in a session (§3, T1, measured). Batch 1 **did
not introduce this**: production code at `64ce357` gives the identical outcome. It is the reason D3 must not be
recorded as closed. It is item 1 of batch 2, and it names a property the ruling does not yet deliver.

---

## 1. A12 UN-COLLAPSE (`0f5fc9b`)

**The cure is the `64ce357` shape plus legibility.** The guarded close is its own `UPDATE … RETURNING id`, with the
`state = 'open'` guard unchanged. `enqueueSubject` follows it, only on the open→closed edge, with the id the close
returned. A failure is logged ("E31 A12: window CLOSED but NOT QUEUED", with the id and cause) and counted in
`enqueue_failed`. `result.error` stays unset.

**Enqueue refused (CHECK on `stt_subject_job`) — measured through the builder's test, and each reader
independently proven real by breaking it:**

| assertion | holds | proof that the reader is real, not stubbed |
|---|---|---|
| window `closed`, 0 job rows, `closed = 1` | yes | — |
| `enqueue_failed = 1`, one log line naming the window with the refusal, no chunk error | yes | A4 (the `64ce357` silent catch) is RED, and A5 (rethrown) is RED |
| `countRoomWaitingWindows` rises by exactly 1 | yes | **A9**: the real count query in `lib/stt/room-drain.ts` broken → the injection test is RED |
| auto-drain's **real** `enqueueAutoDrain` scan offers it, and its legacy enqueue writes the missing row | yes | **A7**: the legacy `enqueueSubject` removed from `lib/stt/auto-drain.ts` → RED. **A8**: the scan's `state = 'closed'` changed → RED |

Only `drainRoomWindow`, the paid step after the scan, is stubbed. **One fact worth knowing:** auto-drain's scan
does not look for a missing `stt_subject_job` row. It offers any closed window with no queued or running
`scribe_job`, and writes the legacy row `ON CONFLICT DO NOTHING`. So it heals this state by construction, but
only when `ROOM_AUTO_DRAIN_ENABLED` is on. That flag ships dark, so in production the live recovery for this
state is the admin run-waiting control. The test proves both readers.

**The re-collapse mutants:**
- **A1** (the `de50dd9` CTE restored verbatim) is RED on the **failure-injection test** ("the close is recorded:
  expected 0 to be 1") and on the source pin.
- **A2** re-collapses by compensation: on enqueue failure it reopens the window, the same outcome a CTE gives. The
  source pin cannot see it, and it is RED on the **failure-injection test alone**.

The bite is behavioural, not textual.

**Minor behaviour note (not a defect):** `isTranscriptEnabled` now sits inside the enqueue `try`. A failed
switch read on a newly closed window counts as `enqueue_failed` instead of setting `result.error`. The window is
closed either way.

## 2. THE ORDER PIN IS BEHAVIOURAL

The test refuses the close (CHECK `state <> 'closed'` on `bench_window`) and asserts that no job exists for the
session. Close-first queues nothing, and enqueue-first leaves a job behind. So the test tells the two orders
apart by an outcome only the wrong order can produce, rather than restating the source. With the refusal lifted,
the same tape closes and queues (1 and 1), so the zero is not an unclosable tape.

**A3** (the enqueue of the window id moved before the close) is **RED on the behavioural order test**:
"an open window was never queued: expected 1 to be 0". It also trips the injection test, the source pin and the
room-switches reader count.

## 3. THE LOGIN (`2cfbbe7` → `1c5d32b` → `9aabfe3`) — MEASURED THROUGH THE REAL ROUTE

A temporary untracked probe (deleted afterwards) drove the real `POST /api/auth/pin` against postgres:16. Only
`signDoctorJwt` and `setDoctorCookie` were spies, as in the builder's suite. Failures were injected with
`BEFORE` triggers.

**Q: Can a wrong pin whose failed-attempt write does not land be answered with anything but a refusal? — No.**
- **T1:** 80 of 80 wrong pins → `500 PIPELINE_FAILED`, no JWT.
- **T3:** failing counter write at stored counts 4, 9, 19, 29 → `500` every time.
- Mutants **B2** (route allow-both), **B3** (the lib's throw read as `ok`) and **B6** (zero rows read as `ok`) are
  all RED.

**Q: Can a lock be claimed that was not recorded? — No.**
- **T3:** at 4, 9, 19 and 29 the row is unchanged, `active`, with `locked_until` null. Never `423`, never `403`.
- Mutants **B5** (an in-memory threshold on throw) and **B8** (the decision read from memory, not the row) are RED.

**Q: Can a correct pin be refused because a non-security write failed? — No.**
- **T4:** `pin_attempt` INSERT fails → `200` and a JWT. Audit INSERT fails → `200`. Reset UPDATE fails → `200`. All
  three fail together → `200`.
- Mutants **B1** (route refuse-both) and **B4** (lib refuse-both) are RED.

**Symmetry, both directions, at both layers — all RED:** B1, B2, B3, B4. The rest of the B set is RED too: B7 (the
R58 attempt row re-collapsed into the counter statement), B9 (reset zero rows read as `reset`), B10 (a slug added
to the audit metadata), B11 (the audit actor reverted), B12 (a JWT minted on the wrong-pin path), B13 (the D1 guard
reverted to the field test).

### The ruling, reviewed as asked

**Where the limiter still records, the asymmetry is right.** **T2**: only the clinician UPDATE fails and
`pin_attempt` still lands. A second guess inside the second → `429`. After 60 attempts in the hour, even the
correct pin → `429`, with no JWT. Guessing is bounded at 60 per hour, and a clinician with the right pin is not
locked out. 2cfbbe7's blanket refusal would have locked out every clinician here for nothing.

**Where nothing records, the ruling's stated property is not delivered.** **T1**, a database that refuses writes
but serves reads, which is how a read-only database behaves (storage quota, read-only failover). Failing the
clinician UPDATE, the `pin_attempt` INSERT and the `audit_log` INSERT:

```
80 wrong pins:   {"500:PIPELINE_FAILED": 80}    counter 0, status active, attempt rows 0
then correct:    200:OK, JWT minted 1
```

The property is "an unrecorded FAILURE must not be ignored". All 80 unrecorded failures were ignored in the only
sense that matters: nothing bounded the next guess. **Refusing a wrong pin is not a defence, because a wrong pin
never authenticates anyway.** `500` against `401` changes the status code, not what the attacker can do next. A
failure is "not ignored" only if it limits later attempts. With the counter and the limiter both blind, the only
remaining limit is refusing the success that follows. R63 removed that, so the rationale "a correct pin is not a
guess" does not hold in T1: the correct pin *is* the winning guess. The 4-digit space is 10,000 PINs, with no
lockout at 30 and no 60/hr limit.

**It is not a regression.** At `64ce357` (production) `recordFailedAttempt` swallowed both writes and
`recordSuccessfulAttempt` issued the session regardless, so T1 has the same ending there. Batch 1 is strictly
better than production: no false lock claims, a loud failure path, a limiter that survives a clinician failure.
Hence ship.

**The property batch 2 needs, named not chosen:** *never issue a session while no brute-force bound is
recording.* One shape: refuse a correct pin only when its reset did not land **and** its own `pin_attempt` row
did not land either. That covers T1. It still admits T2, where the limiter records, and never refuses a correct
pin during a clinician-only fault. The choice is the Orchestrator's.

## 4. THE AUDIT ROW — INFERRED SQL CLOSED

**Method:** all 95 migrations applied in order to an ephemeral postgres:16, **95 ok, 0 failed**. Then
`information_schema.columns` for `audit_log`:

| INSERT names | live column (ordinal) | type | nullable | compatible with the value |
|---|---|---|---|---|
| `actor_type` | 2 | `actor_type` enum `{admin,doctor,system}` | NO | `'system'` is a member |
| `actor_id` | 3 | text | YES | `'auth:pin-lockout-v1'` |
| `action` | 4 | text | NO | `'auth.pin_reset_write_failed'` |
| `target_type` | 5 | text | NO | `'doctor'` (also read by `lib/admin/doctor-detail.ts:164`) |
| `target_id` | 6 | text | YES | clinician id; `clinician.id` is text |
| `metadata_json` | 7 | jsonb | YES | `$4::jsonb` |
| `RETURNING id` | 1 | uuid, default `gen_random_uuid()` | NO | `audited = rows.length > 0` does not depend on the id's value |

The other columns (`ip`, `user_agent`, `created_at`) are nullable or defaulted. The only constraint is the primary
key, and there are no triggers. **No later migration alters `audit_log` or `actor_type`:** a grep for
`ALTER TABLE audit_log`, `DROP`, `RENAME` and `ALTER TYPE actor_type` over `db/migrations/` finds nothing.

**Executed, not just read:** the exact INSERT, PREPAREd with untyped parameters (the Neon driver's shape),
inserted one row with a uuid id. On the same real schema, where `clinician.status` is the `doctor_status` enum and
not the fixture's text:
- the counter UPDATE took 29 → `30|locked` and 4 → `5|active|900`;
- the reset UPDATE returned the id, and matched 0 rows for a missing id;
- the `pin_attempt` INSERT with `$2::inet` landed.

**Metadata payload:** `{reason: "threw"|"zero_rows", stale_failed_pin_count: <int>}`. A closed code and a count.
No free text, no pin, no name, and no slug (B10 pins this). The doctor id is in `target_id`, not in the metadata.

## 5. THE HARNESS (`b29d9af`)

**First, a correction to the premise.** The E31 suites (`e31-atomicity-a`, `e31b-atomicity`,
`e31-a1-bookkeeping-survives`, `s1-emotion-zero-scored`, …) do **not** run through `pg-harness.ts`. They use
`tests/support/s1-pg.ts`, which has its own bound-parameter wrapper. Its header says "WHY NOT pg-harness.ts". Its
`mainStatementAt` already skips string literals, `--` comments and `/* */` comments (block comments without
nesting). `pg-harness.ts` serves **`c2-e2e-runner` only**, plus `container-name`'s name check. So a defect here
cannot silently weaken the one-statement cures' tests. The harness report's claim that "every cure … runs through
here" is wrong.

**Reverts, each run against `pg-harness.test.ts` (baseline 9/9):**

| revert | result | caught by |
|---|---|---|
| F1 line-comment masking | RED | DEFECT 1 + 3 others |
| F2 block-comment masking | RED | DEFECT 3 |
| F2b block comments no longer nest | RED | DEFECT 3 |
| F3 statement head off raw text | RED | leading-comment case |
| F4 no newline before `)` | RED | DEFECT 4 (psql syntax error) |
| F5 exec terminator off raw text, and no newline | RED | DEFECT 2 (text regex) |
| F5b no newline only | RED | DEFECT 2 (text regex) |
| F6 `returning` off raw text | RED | comment-only-mention case |
| F7 trailing `;` off raw text | RED | real-terminator case |
| F8 final-SELECT scan reads raw text | RED | DEFECT 3 |
| **F9 string-literal masking removed entirely** | **GREEN — survives** | nothing |
| F10 `''` escape ignored in the mask | GREEN | equivalent (the two halves mask identically) |
| F5-pure: terminator off raw text, newline kept | GREEN | equivalent in practice (below) |

**DEFECT 2's premise does not reproduce.** "psql, handed a statement it never saw terminated, silently ran
nothing." I measured the opposite on postgres:16: `printf 'CREATE TABLE raw_semi (id int) -- done;' | psql`
exits 0 and **the table exists**, because psql runs its unterminated buffer at end of input. So that test bites
on its text regex, not on behaviour. The fix is harmless.

**My own probes, run through `statementForPsql` and executed.** 12 inputs, effects read back.

- **Pass:**
  - `--` and `/* ( */` inside string literals
  - an exec UPDATE whose trailing comment says "returning;", which runs exactly once
  - a block comment holding `--`, `'` and `;` before a SELECT
  - a data-modifying CTE INSERT with `(` and `;` in a block comment: runs once, and the effect is visible
  - `WITH … UPDATE … RETURNING`
  - a plain SELECT, still nested and returning rows
  - an E-string with `\'`
- **Fail, and every failure is loud (a Postgres error), never silent:**
  - **P3:** a line comment between the last CTE and the final SELECT
    (`…) -- done; it's final⏎SELECT …`). The joiner `, __q AS (` is appended after `.replace(/\s+$/, "")`, onto
    the comment's line, so it is commented out → `syntax error at or near ")"`. It is the DEFECT 4 class, fixed on
    the tail and not on the join.
  - **P7:** `WITH … INSERT … SELECT … RETURNING` → syntax error. The last-SELECT rule is wrong for a DML main
    statement. This predates the change, and `s1-pg` handles it correctly.
  - **P11:** a double-quoted identifier containing `'` → nested → "data-modifying statement must be at the top
    level".

**The wrapping it kept still serves its purpose.** Plain SELECTs nest and return rows, WITH statements keep their
CTEs at the top level, and non-returning statements take the exec path. `c2-e2e-runner`, its only real consumer,
is 51/51 green in the merged tree.

## 6. CROSS-BRANCH

The merge was re-probed at the new heads inside a scratch `git clone --shared`, so V's repo gained no objects and
no refs. `-a`, then `-b`, then the harness onto `64ce357`: **no conflicts**, final tree `cbd9d82`. No file is
touched by more than one branch.

**No fixes interact.**
- A12 writes `queued` legacy rows on close, exactly as `64ce357` did.
- Half B's A4 marks the job `done` only if that window's `transcribing` → `transcribed`/`silent` update matched.
- For A12's failure state (closed, no job row), A4's UPDATE matches no job and changes nothing, as before.
- `countRoomWaitingWindows`, `drainQueuedRoomWindows` and the auto-drain scan are untouched by `-b`. `-b`'s A7
  touches `transcription_run` only.
- The merged tree runs A's A12 test against B's `room-drain.ts`, and it passes.

**Merged-tree gate, in a real git checkout (the clone):**
```
typecheck 0 · typecheck:tests 0 · vitest Test Files 118 passed (118), Tests 2818 passed (2818) · build 0 · check:silent Found 9
```
2818 = 2769 base + 16 (A) + 24 (B) + 9 (harness). The check:silent list is the same 9 files as the accepted list.

## 7. GATES AT EACH HEAD — RUN MYSELF, DOCKER UP, NO EXCLUSIONS

```
-e31a 0f5fc9b  typecheck 0 · typecheck:tests 0 · vitest 116 files / 2785 passed · build 0 · check:silent Found 9 (accepted)
-e31b 9aabfe3  typecheck 0 · typecheck:tests 0 · vitest 115 files / 2793 passed · build 0 · check:silent Found 9 (accepted)
-e31c b29d9af  typecheck 0 · typecheck:tests 0 · vitest 115 files / 2778 passed · build 0 · check:silent Found 9 (accepted)
```
These match each builder's gate exactly. (`check:silent` exits 1 whenever it finds anything; the 9 are the
accepted set.)

## 8. MUTATION RUNS — MINE

Harness: each anchor asserted to match exactly once (VOID otherwise), sha256 of every touched file checked
before and after, files restored after every mutant, `git status` unchanged at the end. It passed on all three
trees. No VOIDs.

- **`-a`:** six suites (`bench-window`, `build3-recovery`, `e31-atomicity-a`, `ended-disagrees`, `room-switches`,
  `s1-auto-drain`), baseline **180/180**. **9 run, 9 RED.** A1 re-collapse verbatim, A2 re-collapse by
  compensation (RED on the injection test only), A3 order reversed (RED on the behavioural order test), A4 silent
  catch, A5 rethrown, A6 `state='open'` guard dropped, A7/A8 auto-drain scan broken, A9 run-waiting count broken.
- **`-b`:** `e31b-atomicity`, baseline **24/24**. **13 run, 13 RED** (§3).
- **`-c`:** `pg-harness.test.ts`, baseline **9/9**. **13 run, 10 RED, 3 GREEN:** F9 is a real test gap; F10 and
  F5-pure are equivalents.

**Total: 35 run, 32 RED, 1 survivor (F9), 2 equivalents.**

Probes, not counted as mutants: login T1–T4 and splitter P1–P12, both in temporary untracked files deleted after
their runs.

## 9. SQL AND EXTERNAL-SCHEMA ASSUMPTIONS

Nothing inferred remains for the audit row: §4 closed it against the migrated schema. **Still inferred:** that
production's `audit_log` matches the repo's migrations. The check is
`SELECT column_name, udt_name FROM information_schema.columns WHERE table_name='audit_log' ORDER BY ordinal_position;`,
and the result should be the ten rows in §4. Test-only SQL I ran, all in ephemeral containers: the migrations
themselves, `BEFORE` triggers raising on `clinician UPDATE` / `pin_attempt INSERT` / `audit_log INSERT`, and the
PREPAREd lockout and audit statements quoted verbatim from `lib/lockout.ts` at `9aabfe3`.

## 10. MERGE AND SHIP

**Yes. Merge `0f5fc9b`, `9aabfe3` and `b29d9af` into `vinay/s1-auto-drain` and ship. Nothing must change first.**

**Batch 2 list, in priority order:**
1. **SECURITY — not taste.** Brute force is unbounded under write-refusing degradation (§3, T1). The property to
   deliver: *never issue a session while no brute-force bound is recording.* It predates E31. Do not record D3 as
   closed until it is delivered.
2. Carried: the narrow emotion failure write dies on a `diarize_stale` row. The builder excepted it in writing in
   `0f5fc9b`.
3. The R61 drift test covers `segments_*` only. `cap_s` and `error` drifts survive, and the one-policy rule is
   measured to hold (see the half-A fix refutation).
4. Harness:
   - F9: string-literal masking has no test.
   - P3: a comment before the final SELECT breaks the join, loudly.
   - P7: `WITH … INSERT … SELECT … RETURNING`, loudly.
   - DEFECT 2's premise is false; retitle it.
   - The harness report's scope claim is wrong: `s1-pg` carries the E31 suites.
   - The comment at `lib/emotion/store.ts` ("NO APOSTROPHE … pg-harness.ts") names a harness these suites do not
     use.
5. The A2 injection is blind to the row-then-delete order. A second injection on the delete side would close it.
6. The R62 builder report is missing from the bus.

## 11. NOT DONE

No Swift (R30/R27). No subagents. I did not drive an HTTP request end to end beyond the route handler, and cookie
and JWT signing are stubbed there, as in the builder's suite. I did not test against a live database. §4 used
the repo's migrations in an ephemeral container.
