# ETA — THE CORPUS IS 5% BUILT (19 SEP 2026)

**KIND:** REPORT · **Author:** Fable (orchestrator) · **Status:** measured, not inferred

## The finding

Every downstream slice — Jev Arm D, speaker identity, role inference, fuse scoring — is
starved rather than broken. There is almost no transcript corpus for them to work on.

| quantity | value |
|---|---|
| `bench_window` rows total | **2,975** |
| windows that have ever had a `transcription_run` | **144** (4.8%) |
| windows with non-empty text | **124** (4.2%) |
| `state='closed'` windows with no run at all | **2,451** |
| audio in that backlog | **612.8 hours** |
| sessions the backlog spans | 102 |
| room-days the backlog spans | ~88 (largest: 96, 95, 93 windows) |

`bench_window.state` breakdown: closed 2,453 · open 277 · transcribed 142 · silent 95 · failed 8.

Clips are extracted at drain time, not at window creation: `clip_r2_key` is present on
142/142 transcribed, 95/95 silent, 7/8 failed, and only 3/2,453 closed. So the 2,451
undrained windows are **not** missing audio — their clips have simply never been cut.
That is a queue that has not run, not a data loss.

## What it costs to close

Measured on the 129 `engine='route'` runs that have landed:

- p50 latency **181.5 s** per window, mean 183.3 s, max 613 s
- windows average **900 s** of audio → real-time factor ≈ **0.20**
- 2,451 × 183 s ≈ **125 hours** of single-stream Mini time ≈ 5.2 days continuous

Concurrency is the only lever that matters here; the per-window cost is already good.
The Yoga is not a lever — it is closed as a diarization producer (10.4× slower, and
arm64 vs x86_64 gives 8 of 8 boundary differences at speaker changes against a 43%
base rate). Its embeddings remain interchangeable (cosine 1.00000).

## Diarization is further behind still

`room_diarize_window`: **146 rows, 138 `state='ok'`** — against 2,975 bench windows.
Diarization has run on roughly 4.6% of the corpus, concentrated in 18 room-days.

## Why J4 could not run

Arm D was executed tonight against production (env live, migrations 0106–0108 applied)
and stopped at room-day 1 of 10 by its own stop rule:

1. J0 `jev_english` wrote 55/55 `jev_window_text` rows for `rd_qjhvj9n9` — but 46 of 55
   were `not_ready` and 9 `empty`, because only 20 of that room-day's 55 windows have any
   transcription run and only 11 of those carry text.
2. J2 `jev_window` wrote 55/55 `jev_window_signal` rows, **all `skipped:no_english`
   placeholders, zero Jev calls.**
3. J3 `jev_role` wrote zero rows: all 18 diarized-turn texts fall under jev-role.ts's
   40-character `CHAR_FLOOR`.
4. Fuse `arm=jev` was never reachable: `scribe_fuse_run` accepts `arm ∈ {rules, hybrid,
   flash}` only, and requires a scratch `rd_scratch_*` id — the production room-days
   cannot be passed to it.

`ETA_JEV_ROLE_ALLOW_NON_ENGLISH=1` did reach the job — the non-English skip count was 0,
which is the correct behaviour, not a masked failure.

**So the Jev result tonight is a non-result about Jev and a real result about the corpus.**

## What follows from this

1. The drain is the build. Nothing downstream can be evaluated until it runs.
2. Arm D stays parked, not abandoned: the tables, the job kinds, the env and the migrations
   are all live, so it re-runs on command once room-days have text.
3. Two defects surfaced that are worth fixing before the drain, because they are cheap and
   they change what the drain records:
   - `scribe_fuse_run` has no production-room-day path for `arm=jev` (BLOCKING for J4).
   - `scribe_job_submit`'s published kind enum omits `jev_english` / `jev_window` /
     `jev_role`; they are registered server-side and submit fine. Stale tool docs only.
4. The 40-char `CHAR_FLOOR` in jev-role.ts is doing real work and should not be lowered to
   manufacture rows. Short turns are short turns.

## Shipped alongside this measurement

- `eda31b0` on `vinay/s1-auto-drain`, production `czvsr7h98` — VAD starvation +
  route-metrics truth (`135d33e`, Refuter PASS with mutation proof) and S2B re-enrolment
  (`1072421`). 140 test files, 3,147 tests, 0 failures.
- Migrations **0106, 0107, 0108** applied. `schema_migrations` max 108, no gap.
- Only **2 of 144** bench-window runs carry `route_outcome` today. From here every route run
  records `windows_total` / `windows_skipped`, so the starvation question the drain is meant
  to answer will be answerable from the rows rather than by re-running.

## Method note

All figures are counts from production Postgres. No transcript text, note text, clinician
or patient name, or room label was read or recorded. The connection string was read at run
time from the RTF, held in process memory only, and never placed on a command line.
