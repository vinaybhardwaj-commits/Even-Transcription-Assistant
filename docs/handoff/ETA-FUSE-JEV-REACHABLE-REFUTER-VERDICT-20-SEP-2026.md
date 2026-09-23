# ETA-FUSE-JEV-REACHABLE-REFUTER-VERDICT — 20 Sep 2026

Diff refuted: `38a7dac` (vinay/fuse-jev-reachable), merged to `vinay/s1-auto-drain` as `56c2a90`.
Checked against the LIVE database, read-only; the builder's own run was mocks-only with Scribe MCP down.
Counts and ids only.

## Q1 — is the scratch guard byte-for-byte unchanged, and does it still fire before any read? **PASS**

- Byte-for-byte identical: 571 bytes on each side, sha1 `9715d9268eaa3d907e260e675d40364eae08cec8` on
  both `38a7dac^` and `38a7dac`.
- git reports no hunk covering those lines (changed old-line anchors: 29, 114, 119, 138–148, 155, 167,
  173, 205).
- Ordering holds: guard at `fuse.ts:230`; first read `readCuesForFuse` at `:234`; `runArm` — the only
  thing that reads signals or sessions — at `:235`.

## Q2 — can the two IST dates disagree for a session crossing IST midnight? **YES — FAIL**

The two are different facts, not two spellings of one:
- `listBenchSessions` filters `(s.started_at AT TIME ZONE 'Asia/Kolkata')::date = ist_date`
  (`lib/bench.ts:234`; its own field doc at `:162` reads "IST calendar date of session **start**").
- `resolveTapeSessionsForJev` passes `day.ist_date`, a **stored `room_day` column**
  (`SQL_ROOM_DAY_BY_ID`, `lib/brain/state.ts:99`).

Measured on live data today:

| fact | count |
|---|---|
| sessions crossing IST midnight (start date ≠ end date) | 2 (`bs_ebzkeda3`, `bs_g3dwud4p`) |
| windows whose `room_day.ist_date` ≠ session-start IST date | **447** |
| sessions involved | **5** |
| room-days involved | **8** |
| of those room-days, ones where the started_at filter returns **zero** sessions | **7** (holding 25–96 windows each) |

The dominant mechanism is **not** only midnight-crossing — it is **multi-day sessions**:
- `bs_szx6nxwh` started 2026-09-18 and owns windows in `rd_e5unw9g4` (09-19) and `rd_s9gs9j8s` (09-20)
- `bs_3rmj9amg` started 2026-09-11 and owns windows in `rd_drhk696k` (09-12), `rd_8csftxs2` (09-13),
  `rd_ph8w2gu4` (09-14)
- `bs_tt6xhqxt` started 2026-09-13, windows in `rd_zee5hsef` (09-14)

Consequence, exactly as feared: for a scratch day replaying one of those (room, IST date) pairs,
`listBenchSessions` returns 0 → `resolveTapeSessionsForJev` returns `[]` → arm=jev returns
`ok:false, error:"no_jev_signals", detail:"no_bench_sessions_for_day"`. The signals exist; they are
never looked for. It fails closed and reads as "no tape for the day", which is indistinguishable from
the honest case — fixed-looking and unreachable.

## Is it firing right now? No — latent

Only 2 scratch days exist (both 2026-08-19); both resolve sessions (1 and 3), so nothing is broken
today. It fires the first time a scratch day is created for any of the 7 affected (room, IST date)
pairs — a set that includes yesterday and today.

## Smallest honest fix (NOT applied)

Key the walk-back on the same fact J2 keys its rows on:
- **(a) preferred** — take the sessions the day actually has: `SELECT DISTINCT session_id FROM
  bench_window WHERE room_day_id = <real room-day id>`, instead of selecting by start date. This
  cannot drift from what J2 wrote, because it is the same attribution.
- (b) alternative — keep `listBenchSessions` but match sessions that OVERLAP the day
  (`started_at < day_end AND (ended_at IS NULL OR ended_at > day_start)`) rather than start within it.

A test that would have caught it: one session whose `started_at` IST date is the day before the
room-day under test, asserting arm=jev still reaches its signals. The current suite cannot see this —
it mocks both sides of the date.

## Also noted (not asked)

`jev_window_signal` now EXISTS in live and `schema_migrations` max = **108** (0106/0107/0108 applied
since 19 Sep). Migration 0110 (jev_window_signal.status/error) therefore has its prerequisite live.

**Verdict — Q1 PASS, Q2 FAIL.** The arm is reachable only for days whose sessions started on that same
IST date; 7 live room-days are already outside that set.
