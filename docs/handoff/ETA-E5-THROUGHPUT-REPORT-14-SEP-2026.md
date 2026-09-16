# ETA-E5 — THROUGHPUT REPORT · 14 Sep 2026 · Builder (`scribe`)

**NO RUN. I stopped at scope step 2: the manual path and the auto path diverge, and the auto path cannot reach this sample.**
Nothing was enqueued, submitted, claimed or written in production. Only the step-1 sample file and read-only SQL were produced.
Tree `vinay/s1-auto-drain` @ `f798edf`, unchanged. No commit. Read window 10:48–10:51 UTC.

## 1. The three headline numbers
1. Sustained windows per hour: **not measured.** Not one window was run.
2. Failure rate: **not measured.**
3. p50 / p90 / max wall clock: **not measured.**
4. Ceiling read from code, NOT measured: at most **12 windows an hour** can reach "done" through the crons (§6 F4).

## 2. V1–V6
- **V1 UNVERIFIED.** Nothing was processed. The sample file holds 40 unique ids: 4 rooms × 10, across 5 IST days.
- **V2 FAIL.** The paths diverge. See §3.
- **V3 UNVERIFIED.** No run, so there is no "done" to check.
- **V4 UNVERIFIED.** I have no Vercel access, and `scribe_health` does not report flags. I changed no flag, env var or room row.
  The last emotion job (`job_pkeqyzepn061`, 04:06 UTC) failed with `emotion_disabled: EMOTION_ENABLED is off`. It ran
  before the flags were created, so it says nothing about now. Names only: `ROOM_DIARIZE_ENABLED`, `EMOTION_ENABLED`,
  `ROOM_AUTO_DRAIN_ENABLED`, `AUTO_DRAIN_BATCH_LIMIT`.
- **V5 PASS for the read window, by windows.** 0 windows closed in the last 60 min, and 0 `bench_session` rows with
  status `recording`. A caveat is in §6 F6.
- **V6 PASS.** `127.0.0.1:8083/healthz` → 200 at 10:48 and again at 10:51 UTC. I did not hit an IndexError, because nothing was routed.

## 3. The finding: the path (scope step 2)
**Auto path, transcription only:** `lib/stt/auto-drain.ts:133` `enqueueSubject` → `:135` `drainRoomWindow`
(`lib/stt/room-drain.ts:423`). That function checks the Transcript switch (`:457`), claims the window (`:484`) and
submits a `room_window` job (`:503`). The job joins the clip and writes `bench_window.clip_r2_key` (`room-drain.ts:643`).
**Auto-drain never enqueues diarize or emotion.** Those enter through two separate `*/5` crons:
`enqueueDiarizeWindows` (`lib/stt/diarize-job.ts:110`) and `enqueueEmotionWindows` (`lib/emotion/enqueue.ts:28`).

The manual doors I could use, and why none is the auto path for this sample:
- `app/api/admin/drain-windows/route.ts:82` calls `enqueueAutoDrain` itself, so it is identical. But it drains nothing
  while `ROOM_AUTO_DRAIN_ENABLED` is off (`auto-drain.ts:92`), and it only selects windows closed within
  `AUTO_DRAIN_MAX_AGE_HOURS` = 6 (`:117`). Every backlog window is older than that. Both are forbidden to change.
- `app/api/admin/bench/drain/route.ts:97` calls `drainRoomWindow` directly: same function, but **it skips `enqueueSubject`**
  (`auto-drain.ts:133`, the row the drain's retry bound counts on). It needs an admin cookie, which I do not have.
- MCP `scribe_job_submit kind=room_window` enters at `submitJob` and **skips `drainRoomWindow` entirely**: no
  Transcript check, no claim, no state change to `transcribing`. That is a different path, so I did not use it.

**The step that blocks any faithful run: 7 of the 9 backlog rooms have Transcript OFF** (Q7, current value of
`room.transcript_enabled`). `drainRoomWindow` answers `flag_off` for them on entry (`room-drain.ts:457`), through every
door that uses it. Only `room_ymch4bxu` (113 windows) and `room_2qe955hy` (76) can be drained: **189 of 1,378 (13.7%)**.
The kickoff's "at least 4 distinct rooms" cannot be met through the auto path without switching Transcript on in more
rooms. That is a room-row change, which this brief forbids.

**And no window can be diarized before it is transcribed.** **0 of 1,378 have a clip** (Q7). The diarize scan requires
`clip_r2_key IS NOT NULL` (`diarize-job.ts:131`), the diarize job fails `clip_missing_in_r2` without one
(`lib/jobs/kinds/diarize-window.ts:45`), and emotion requires diarize `ok`. The pipeline is strictly serial:
drain → diarize cron → emotion cron.

## 4. Per-stage timing
None. No stage ran. `docs/handoff/scratch/E5-RAW-14-SEP-2026.json` was **not created**, because there is no per-window data.

## 5. Failure breakdown by cause
None from this task. For context only, from existing `scribe_job` rows in the last 24 h (all actor `mcp:operator-v1`,
03:47–04:07 UTC, not mine):
- `emotion_window` ×4 — `emotion_disabled: EMOTION_ENABLED is off`
- `diarize_window` ×3 — `progress_incomplete: no such window`
- `room_window` ×1 — `room_window_failed: cues_refused` (step `segment`)
- `room_window` ×1 — `room_window_failed: not_found`

## 5b. First-10 vs last-10 rate
Not measured.

## 6. Flags
- **F1. The demand figure counts windows auto-drain will never take.** Ruling §1.2's 28–32 closes an hour is taken across
  all 9 rooms. By today's switches, 86% of the backlog sits in Transcript-off rooms that `auto-drain.ts:113` excludes
  before its `LIMIT`. The cap argument in R3 should be re-cut on Transcript-on rooms. That is the Orchestrator's call.
  Caveat: Q7 reads the switch **now**. Its value on 09–13 Sep is not recorded anywhere I read.
- **F2. The zero cron activity is explained by the missing clips, not by the flags.** I first read "no diarize/emotion
  job in 6 h 42 m" as the flags not being live. That is withdrawn: with 0 clipped windows the diarize scan has nothing to
  select whatever the flag says. Flag liveness stays UNVERIFIED (V4).
- **F3. The backlog is safe from the diarize cron only because it has no clips.** That scan has no age limit and takes
  **oldest first** (`diarize-job.ts:141`). Any window that gets transcribed, by any door, becomes eligible for diarize and
  then emotion within two ticks. A measurement on N windows therefore stays at N. But draining the backlog in bulk would
  also diarize and score it in bulk, which is R7's decision (V's).
- **F4. Structural ceiling, read from code, not measured.** Emotion is enqueued one job at a time system-wide, and not at
  all while one is queued or running (`lib/emotion/enqueue.ts:46-47`, `LIMIT 1` at `:65`), on a `*/5` cron (`vercel.json`).
  At most **12 windows an hour** can reach a `room_emotion_window` row by cron, whatever the Mini's speed. Diarize enqueues
  `DIARIZE_BATCH_LIMIT = 4` per tick (`diarize-job.ts:57`), i.e. at most 48 an hour. Auto-drain enqueues 1 per tick, 12 an hour.
  **Under the done-definition in scope step 4, raising `AUTO_DRAIN_BATCH_LIMIT` alone cannot lift throughput past 12 an hour.**
- **F5. The backlog includes today.** 105 of the 1,378 windows have `end_ms` on **14 Sep** (OPD 7: 52, OPD 4 – Ortho: 53),
  and the same two rooms have 57 and 95 on 13 Sep. These are likely the K1 kiosk windows (inferred). The brief says 09–13 Sep; my sample excludes 14 Sep.
- **F6. The "is it recording?" views disagree again.** `scribe_health` listeners show OPD 1, OPD 3 and OPD 5 as
  `recording: true`, each with a `recording_session_id`. Their last poll was 2.3 h earlier, and `listening` is false.
  Q6 found 0 sessions with status `recording`, and no window closed in 60 min. The status literal `'recording'` in Q6 is a guess,
  INFERRED and checked against neither code nor schema. Per carryover §5, chunks are the honest signal. I did not count chunks.
- **F7. Sample shape.** `docs/handoff/scratch/E5-SAMPLE-14-SEP-2026.json`: 40 ids. `room_ymch4bxu` (10, 11 Sep) and
  `room_2qe955hy` (09, 13 Sep) have Transcript on. `room_ux92qpws` and `room_qyzghzaf` (12, 13 Sep) have it off. 5 per
  room-day, ordered by `md5(id)`. `has_clip` is false for all 40. **20 of the 40 would answer `flag_off`.** If the ruling
  changes the room set, re-select; do not reuse this file silently. `room_2qe955hy` is named "Home Office" in the listener
  view, so it may not be clinic audio.
- **F8. An environment premise did not hold.** The repo `CLAUDE.md` says there is no live database in this sandbox, but
  `APP_DATABASE_URL` is set in this shell. I used it only inside `BEGIN READ ONLY … ROLLBACK`. Every statement is
  verbatim in `docs/handoff/scratch/E5-QUERIES-14-SEP-2026.sql` (Q1–Q8). I also used MCP read tools `scribe_health` and
  `scribe_job_list`. I did not print any secret value.

## For the Orchestrator to rule (not decided here)
1. Which rooms may the measurement use, given that only 2 are Transcript-on, and does switching more on fall inside R4?
2. Which entry point counts as "the auto path" for a backlog window? The auto door itself is gated by a flag and a 6 h age limit.
3. Does "done" keep the emotion row, given the 12-an-hour emotion ceiling (F4)? Or does the measurement report each stage's rate separately?

Subagents: none. Files written: this report, `scratch/E5-SAMPLE-14-SEP-2026.json`, `scratch/E5-QUERIES-14-SEP-2026.sql`.
