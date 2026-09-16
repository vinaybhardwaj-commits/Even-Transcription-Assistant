# ETA-E9 — LIVE RUN · INTERIM · 14 Sep 2026 · Builder (`scribe`)

**Line 1: UNKNOWN. I stopped at step 1.** The Claude Code permission layer (auto-mode classifier, reason "Modify Shared
Resources") denied the step-1 `UPDATE room`. After that it also denied a read-only `psql` SELECT and the MCP
`scribe_job_list` read. I did not retry around the denial. I have no view of production from this session now.

## What was done
- **Step 0 — done.** `scratch/E9-BEFORE-14-SEP-2026.json`, captured 11:21:38 UTC, verified on disk before step 1.
  13 rooms; Transcript on in 2 (`room_2qe955hy`, `room_ymch4bxu`). `bench_window`: closed 1,452 · transcribed 16 ·
  open 183 · failed 1. Clips 16. `room_diarize_window` ok 15. `room_emotion_window` 0. `auto_drain_refused_at` set on 0 windows.
- **Step 2 — the drain was live before I touched anything.** One `room_window` job created 11:20:17 UTC with status `done`
  at snapshot time, and clips went 15 → 16 against the E8 cut. I did not identify which room that window came from.
- **Step 1 — NOT done.** The denied statement, which never ran:
  `UPDATE room SET transcript_enabled = TRUE WHERE id IN ('room_4ggnkg5x','room_87frpus9','room_bh6jtq4t',
  'room_pnyc9u49','room_qyzghzaf','room_ux92qpws','room_yh3etjpf') AND transcript_enabled = FALSE RETURNING …`
  `room_xf5vcjpt` (OPD Test) was left out on purpose: its only closed window is outside the 240 h bound.
  The same denied command was to write `scratch/E9-WRITES-14-SEP-2026.sql`, and that file does not exist.
  That is consistent with the command never executing.
- **Steps 3–4 — not done.** No samples. `scratch/E9-SAMPLES-14-SEP-2026.json` does not exist.
- **Step 5 — nothing to restore from this session.** No write ran. I could not confirm this with a read after the write (denied).

## V1–V6
- **V1 PASS.** BEFORE was written at 11:21:38 UTC, before any switch attempt.
- **V2 UNVERIFIED.** The cron was draining unattended at 11:20. I opened no door. I could not watch it.
- **V3 UNVERIFIED.** No observation.
- **V4 PASS for my actions.** I set no env var and touched no code. `AUTO_DRAIN_BATCH_LIMIT` absence is as V stated; I did not verify it.
- **V5 UNVERIFIED by read.** Expected to match, because the only write was denied before it ran. A read to confirm was denied.
- **V6 PASS before** (200 at 11:21:38 UTC). After: not checked.

## Flags
- **F1. The rulings conflict.** E8 §6.1: *"Do not switch Transcript on in more rooms for a measurement."* E9 step 1 orders
  exactly that, citing V's authorisation. I followed the later kickoff, and the permission layer stopped it. V to confirm
  which stands before anyone retries.
- **F2. ⚠ The drain is live and nobody is watching it.** `ROOM_AUTO_DRAIN_ENABLED=1` with `AUTO_DRAIN_MAX_AGE_HOURS=240`
  keeps draining the 2 Transcript-on rooms (188 eligible windows, about 16 h at 12 an hour), with diarize and emotion
  following. **E8 §7 requires the flag off before clinic opens tomorrow.** That is a Vercel action, and not mine.
- **F3. Other readers of `transcript_enabled`** (checked before the write, to see if the switch starts spend): the
  window-close enqueue at `lib/bench-window.ts:397` only inserts an `stt_subject_job` row, and
  `app/api/brain/cues/route.ts:271` allows window-cue replacement. I found no paid call gated by the switch.
- **F4. Room count.** 10 rooms hold closed windows, not 9. The tenth is `room_xf5vcjpt`, with 1 window outside the bound.

Subagents: none.
