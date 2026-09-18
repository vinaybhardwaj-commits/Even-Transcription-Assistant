# ETA-E31 — Batch 1, half B (A4, A7, D3, D1) · 16 Sep 2026 · Builder

Worktree `-e31b`, branch `vinay/e31-atomicity-b`, commit **`b04d213`** on `64ce357`. Nothing merged, pushed,
promoted or deployed; no migration created and none applied outside ephemeral containers. Files touched: the four
the order named, plus three test files. No Swift (R30/R27).

## The cures, one line each

| Site | Cure | Shape |
|---|---|---|
| **A4** `room-drain.ts` finish | the `bench_window` update and the `stt_subject_job` update in **one CTE**, the job update conditional on the window update having matched (`EXISTS` over the first CTE) | ONE STATEMENT |
| **A7** `room-drain.ts` `writeRoutedRun` | the `DELETE` of the previous run and the `INSERT` of its replacement in **one CTE**; the delete is a data-modifying CTE on the insert, so it cannot commit without it | ONE STATEMENT |
| **D3** `lockout.ts` | the `pin_attempt` insert and the `clinician` update in **one statement with `RETURNING`**, every returned `kind` read off the returned row | ONE STATEMENT |
| **D1** `visit-update.ts` + `fuse.ts` | **D-3 legibility, not atomicity** (two roles, as ruled): the audit `INSERT … RETURNING id`, an outcome object, intent logged before and outcome after, and `audited: audit === "written"` | NOT one statement — by ruling |

Both A4 guards (`AND state = 'transcribing'`) are preserved verbatim, and E18's silent branch keeps its own
literal statement. D3 now evaluates its thresholds against the row's **own** count, which also closes the
lost-update race two simultaneous wrong PINs used to have.

## The bar: failure injected inside the statement

`tests/unit/e31b-atomicity.test.ts` runs all four against a real postgres:16, with the failure injected by a
trigger that raises on the **second half** of the work. A trigger rather than a mock because atomicity is a
property of the database, not of the driver.

| Site | Injected failure | Asserted earlier state |
|---|---|---|
| A4 | trigger raises on `UPDATE stt_subject_job` | window still `transcribing`, job still `running` |
| A7 | trigger raises on `INSERT INTO transcription_run` | the previous run row intact, with its transcript |
| D3 | trigger raises on `UPDATE clinician` | count unmoved, status unchanged, **and no `pin_attempt` row left behind** |
| D1 | trigger raises on `INSERT INTO audit_log` | `audited:false, audit:"failed"`, zero audit rows, intent logged first |

## Mutation check — 9 caught of 9 run, baseline 91, no survivors, no equivalents

Four suites per mutant (`e31b-atomicity`, `room-drain`, `e11-silent-room-window`, `c1b-room-window-job`).
Checksums recorded before mutating and verified after each restore; no container left behind.

- **A4-split**, **A7-split**, **D3-split** — each CTE re-split into the two statements it replaced: all RED.
- **A4-order** — reversed (job first, window conditional on it): RED on the order pin.
- **A4-guard** — the preserved `AND state = 'transcribing'` dropped: RED.
- **D3-memory** — the decision computed from in-memory state again: RED (after a test was added; see below).
- **D3-nofail** — a failed write answering as though it had landed: RED.
- **D1-state** — `audited` back to `postClose`: RED. **D1-norow** — an insert returning no row still reporting
  audited: RED (after a test was added).
- **D3-memory and D1-norow survived the first run.** Both had real separators — a stale in-memory count against
  the row's own, and a driver that reports a successful insert with no rows (the R54 anomaly class) — so each got
  the test that separates it rather than an excuse.

## Two test harnesses updated, not weakened

`c1b-room-window-job` and `e11-silent-room-window` use text-matching fake databases that return on the first
match, so one statement doing two things registered once. They now model the CTE: e11 records both the window
state and the job completion from the single A4 statement, and c1b reads the routed insert's bound values by an
offset, because A7's delete binds the window id ahead of them. The assertions they make are unchanged.

## Flagged, not decided

1. **D3's failure answer is `{kind:"ok"}`, not a new failure kind.** The PRD says the function "returns a
   failure"; the strongest form — a distinct `kind` the caller must handle — would change
   `app/api/auth/pin/route.ts`, which is outside this half's file list, and the PRD says to stop rather than
   choose when a D3 cure forces a caller change. `{kind:"ok"}` requires no caller change, refuses the attempt
   (the caller answers `PIN_INVALID`), and cannot claim a lock nobody recorded, which is the hard requirement. If
   a distinct kind is wanted, it is one ruling and a small edit at that route.
2. **`writeRoutedRun` is now exported** from `room-drain.ts`, with a comment saying why: the A7 statement had to
   be reachable on its own for the failure-injection test. No behaviour change and the only caller is unchanged.
3. **A4's job update is now conditional**, so a window not in `transcribing` leaves its job alone where the old
   code finished it unconditionally. That is what the PRD ordered, and it is pinned by the order test — recorded
   here because it is an observable behaviour change.

## Gate

`npm run typecheck` 0 · tests typecheck 0 · `npm test` **115 files, 2783 tests passed**, Docker up, no exclusions
· `npm run build` 0 · `npm run check:silent` the accepted 9.
