# ETA-E31 — Batch 1, half B (A4, A7, D3, D1) · REFUTATION · 16 Sep 2026 · Opus Refuter

Target `-e31b`, branch `vinay/e31-atomicity-b`, HEAD **`b04d213`** on `64ce357`, tree clean at start and at end.
Diff `64ce357..b04d213` only: 7 files, 476 insertions, 80 deletions — the four production files the order named
plus three test files. Nothing outside the contract moved. I did not fix anything, did not enter `-e31a`, did not
commit, push, merge, promote, deploy, or apply a migration outside an ephemeral container. No Swift.

## VERDICT

**A4 PASS · A7 PASS · D1 PASS (as legibility, with two narrow flags) · D3 NOT DONE.**

D3 is not done for the reason the order asked me to measure, and for a second reason the order did not ask about
and the builder did not flag: **the cure removed the last brute-force throttle that survived a degraded clinician
table.** Everything else in this half is sound, the tests are honest, and the mutation claim reproduces
independently.

---

## 1. THE D3 ACCESS QUESTION — MEASURED, NOT REASONED

The order: when the lockout write fails, is a CORRECT pin also refused, or does it still authenticate?

**MEASURED ANSWER: a correct pin still authenticates. Access does NOT fail closed.**

Method: real postgres:16, a `BEFORE UPDATE ON clinician` trigger raising for the whole run, eight wrong pins
through `recordFailedAttempt`, then the gate a correct pin actually meets — `preAttemptCheck` on a FRESH read of
the clinician row, which is exactly what `app/api/auth/pin/route.ts:86` does before `bcrypt.compare`. bcrypt is
independent of the database, so `preAttemptCheck`'s answer **is** the access answer.

```
decisions:               ["ok","ok","ok","ok","ok","ok","ok","ok"]
clinician row after 8:   failed_pin_count=0, status=active, locked_until=null
pin_attempt rows:        0
gate a correct pin meets: "ok"   →  correct_pin_authenticates: TRUE
```

By the order's own stated criterion — *"if a correct pin still authenticates while attempts go uncounted, that is
a brute-force hole opened by database degradation and D3 is NOT done"* — **D3 is not done.**

Fairness to the builder: this specific hole is **not new**. The old code also never moved the count when the
clinician UPDATE failed, so the gate was equally blind on the next request. The builder's flag #1 is procedurally
correct — the PRD says STOP and report rather than choose when a D3 cure forces a caller change, and it stopped.
`{kind:"ok"}` does satisfy the hard requirement (it cannot claim a lock nobody recorded). What is wrong is that
the site was reported as cured when the security property the PRD names is still absent.

## 2. THE REGRESSION THE ORDER DID NOT ASK ABOUT — AND IT IS NEW

`preAttemptCheck` enforces the rate limit (1/sec, 60/hr) by **counting `pin_attempt` rows** (`lib/lockout.ts:57`
and `:65`). Those rows were the one defence that still worked when the clinician table was failing, because the
old attempt INSERT was its **own statement with its own catch** — a clinician failure did not take it down.

A7-style atomicity binds the attempt row to the clinician update. When the clinician half fails, **the attempt row
rolls back with it.** The builder's own test asserts this as a virtue ("no `pin_attempt` row left behind",
`e31b-atomicity.test.ts:210`). It is correct for the counter and fatal for the limiter.

Measured, same injected clinician failure, twelve wrong pins each shape:

| | attempt rows surviving | gate after 12 |
|---|---|---|
| **NEW** (one statement) | **0** | **`ok` — no throttle at all** |
| **OLD** (two statements) | 12 | `rate_limited` |
| control: 60 rows in the hour | 60 | `rate_limited` |

So under a clinician-write failure the old code throttled an attacker to 1 attempt/sec and 60/hr; the new code
throttles nothing. **The cure strictly widened the brute-force window it was written to narrow.** This is a
regression introduced by this commit, not a pre-existing condition, and it is not in the builder's flags.

`pin_attempt` serves two masters — the lockout counter and an independent rate limiter. Binding it to the
clinician row hands both to the same failure domain. Not my decision to make; naming it is.

## 3. SPLIT EVERY CTE MYSELF — ALL THREE PINNED

I re-split each CTE into the two statements it replaced, by hand, and ran six suites (`e31b-atomicity`,
`room-drain`, `e11-silent-room-window`, `e11-silent-room-window-real-client`, `c1b-room-window-job`,
`s1-auto-drain`; baseline **166 tests green**). Every patch was asserted to have actually applied — a silent
no-op mutant would otherwise read as "caught".

**A4-split RED · A7-split RED · D3-split RED.** No site pinned nothing.

My full run, independent of the builder's: **9 caught of 9 run, no survivors, no equivalents.** A4-split,
A7-split, D3-split, A4-order (reversed), A4-guard (dropped), D3-memory (decision from in-memory state again),
D3-nofail (a failed write answering as though it landed), D1-state (`audited: postClose`), D1-norow (no-row
guard disabled). All four production files verified byte-identical after restore.

## 4. IS THE TRIGGER HONEST?

Yes. Each trigger is a `BEFORE <event> ... FOR EACH ROW` that raises on the **second half** of the work — A4 on
`UPDATE stt_subject_job`, A7 on `INSERT INTO transcription_run`, D3 on `UPDATE clinician`, D1 on `INSERT INTO
audit_log` — and in every case the assertion is about **database state afterwards**, read back through a separate
query: the window's state and the job's state, the surviving run row and its transcript, the clinician row and the
attempt count, the audit row count. A4's test does also assert the throw, but it asserts the earlier state beside
it, so it is not a test that proves only that something threw. The harness gives each `sql` call its own psql
session, so every statement runs under autocommit — the right model for statement atomicity.

## 5. A7 — THE DATA-LOSS SITE

Both halves proven, against a real postgres, two sessions:

- **Injected failure in the insert half:** the previous run survives with its transcript intact (`run_old`,
  transcript unchanged). Split into two statements it is `[]` — the transcript destroyed.
- **No interleaving with zero run rows.** A concurrent reader polled continuously across a deliberately widened
  commit window (the statement held open ~4 s — far wider than autocommit gives it) observed **only count=1**,
  never 0. The same probe against the OLD two-statement shape observed **0 and 1**. The window A7 closes was real
  and is now closed.

PostgreSQL semantics back this up: a data-modifying CTE always executes exactly once even though the INSERT does
not select from it, and both halves see the same snapshot, so the DELETE cannot remove the row the INSERT is
adding. The builder's comment says exactly this and it is correct.

## 6. A4 — GUARD AND ORDER

`AND state = 'transcribing'` is preserved **verbatim on both legs**, silent and non-silent, and E18's silent
branch keeps its own literal statement. A4-order RED, A4-guard RED.

The behaviour change the builder flagged (#3) is real and I confirm nothing depended on the old unconditional
job update:

- Both admin readers (`lib/admin/room-reads.ts:55` and `:123`) test only that a job row **exists**, never its
  state — so `running` vs `done` is invisible to them.
- `drainQueuedRoomWindows` re-claims only `j.state = 'queued'`, and the enqueue scans skip any window that has a
  job row at all. So a job left `running` is not re-claimable — **but neither was the `done` one the old code
  wrote.** Both are terminal for the scan; the difference is that `running` does not lie and `done` did. That is
  the PRD's intent, and `fanout.ts:298` (`state <> 'queued'` → `queued`) still recovers either by hand.

## 7. D1 — JUDGED AS LEGIBILITY

Intent is logged **before** the act and outcome **after** (`visit-update.ts:198` / `:212`), the D8 shape. One
caller only (`lib/mcp/tools/fuse.ts:273`), and it carries the writer's answer.

I tried eight routes to make it report `audited: true` with no row — empty array, row with no `id`, `id: null`,
`id: undefined`, non-array, `null`, and the R54 driver-anomaly shape. Six are correctly refused. **Two lie:**

- `{id: 0}` → `audited: true` · `{id: ""}` → `audited: true`

The guard is `id === undefined || id === null`, which admits falsy-but-present ids. **Not reachable from
Postgres** — `audit_log.id` is `bigserial`, always ≥ 1 — so this is narrow. But the guard exists precisely to
defend against a driver or proxy that reports success with a degenerate row (the R54 class), and `0` / `""` are
exactly what such a thing returns. One character fixes it: `if (!id)`. Flagged, not fixed.

**Second D1 flag, and it is not about atomicity.** The new intent line logs `...meta` on **every** post-close
change, and `meta` carries `before`/`after` clinician ids **and the operator's free-text `note`** (up to 500
chars). Measured: the emitted line contains both. Previously that payload reached the log **only on failure**.
This is a new routine disclosure of clinician identity and free text into logs, against this repo's standing rule
on identity in logs. The Orchestrator should rule on whether the intent line should carry ids and note at all, or
only `visit_id` + `action`.

## 8. THE TWO HARNESSES — UPDATED, NOT WEAKENED

Confirmed empirically, both directions:

- **The edit was forced, not gratuitous.** Restoring `c1b-room-window-job` and `e11-silent-room-window` to their
  `64ce357` text and running them against the *current* production code: **RED, 6 failed.**
- **They still bind.** With the current harnesses, dropping the A4 job update from the CTE entirely: **CAUGHT.**
  Dropping the A7 DELETE entirely: **CAUGHT.**

I verified c1b's offset by hand against the real binding order: the DELETE binds `windowId` as `$1`, so the
INSERT's `id`, `subject_id`, `engine` sit at `v[1]`, `v[2]`, `v[3]` — which is what `off = 1` reads, and `off = 0`
still reads the shadow insert correctly. e11 keeps its standalone branches below the new combined one, so both
shapes are modelled, and the E18/R52 order pin (`verdictsAtSilentState`) is preserved inside the combined branch.

One cosmetic note, pre-existing and not a weakening: `DB.deletes` in c1b is incremented and **never asserted** —
it was dead before this commit and is dead after it.

## 9. GATE — RUN MYSELF, DOCKER UP, NO EXCLUSIONS

```
npm run typecheck        exit 0
npm run typecheck:tests  exit 0
npx vitest run           Test Files 115 passed (115) · Tests 2783 passed (2783)
npm run build            exit 0, compiled
npm run check:silent     Found 9 silent-failure handler(s) — the accepted 9 at 1193083, all outside the contract
```

Reproduces the builder's gate line exactly. No migration in the delta; none needed.

## 10. SQL AND EXTERNAL-SCHEMA ASSUMPTIONS — INFERRED, VERBATIM

No live database here. Everything below is inferred from source and from the test schema, and needs live
validation:

- `pin_attempt(doctor_id, success, ip inet, user_agent, created_at)` — and that `created_at` defaults to `NOW()`,
  which both rate-limit windows depend on.
- `clinician(id, url_slug, failed_pin_count int, locked_until timestamptz, status, updated_at, deleted_at)`.
- `audit_log.id` is `bigserial` — this is what makes the `{id: 0}` gap unreachable in production. **If that column
  is ever not a positive serial, §7's first flag stops being narrow.** Worth validating live.
- `transcription_run` has no unique constraint on `(subject_type, subject_id)` — A7's replace-by-delete depends on
  that staying true.
- `stt_subject_job` has no unique constraint on `(subject_type, subject_id, tier)` (stated at
  `lib/admin/room-reads.ts:73`).
- The A4 statement writes `bench_window.state = 'silent'`, which needs 0101's widened CHECK — already on the line.

## 11. WHAT I DID NOT RUN, AND WHY

- No Swift (R30/R27, ordered).
- I did not drive `app/api/auth/pin/route.ts` end to end. Its cookie and JWT path needs a Next request context;
  instead I measured the gate it consults, which is the thing that decides access. The measurement is one step
  short of the HTTP boundary and I am naming that rather than claiming a full route test.
- I did not test the D3 two-simultaneous-wrong-pins race. Read-only: the counter is now `c.failed_pin_count + 1`
  evaluated by the database against the row's own value, which does close the lost-update the builder claims.
- No subagents. Every measurement above I ran myself.

## 12. WHAT THE ORCHESTRATOR MUST RULE ON

1. **D3's failure answer.** `{kind:"ok"}` leaves access open under clinician-table degradation. A distinct kind
   (`unavailable` → 503 at `app/api/auth/pin/route.ts:104`) is one ruling and a small edit at a file outside this
   half's list. This is the PRD's "returns a failure", and the builder correctly declined to choose it.
2. **The rate limiter's evidence.** Whether the attempt row must survive a clinician failure — which means it
   cannot be in the same statement — or whether the limiter should be fed from something that is not
   `pin_attempt`. As it stands, one cure removed the other defence.
3. **The D1 intent line's payload** — clinician ids and operator free text, now logged on every post-close change.
4. **`{id: 0}` / `{id: ""}`** in the D1 no-row guard: one character, but it is the R54 class the guard is for.
