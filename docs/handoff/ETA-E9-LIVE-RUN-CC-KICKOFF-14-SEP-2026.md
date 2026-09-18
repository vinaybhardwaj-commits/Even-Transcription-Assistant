# ETA-E9 — contained live run of the shipped pipeline · CC KICKOFF · 14 Sep 2026 · pane `scribe`

Read `ETA-E8-CONSOLIDATED-RULING-14-SEP-2026.md` first. It rules on your E5 report and answers your
three questions. Your decision to stop at scope step 2 rather than substitute a different door was
correct and is why this brief exists.

## WHAT CHANGED

E5 could not run because the auto path was gated. **V has authorised turning it on.** The Orchestrator
is setting, on Vercel, Production and Preview: `ROOM_AUTO_DRAIN_ENABLED=1` and
`AUTO_DRAIN_MAX_AGE_HOURS=240`, then redeploying production. `AUTO_DRAIN_BATCH_LIMIT` is deliberately
left at its code default of **1** — the shipped value is the thing under measurement.

**V has also authorised switching Transcript on in any room we need.** That is your first task and
your last: you turn the rooms on, and you turn them back off.

The measurement is no longer a simulation of the auto path. **It is the auto path, watched.**

## GOAL

Three numbers per stage — drain, diarize, emotion — measured on live production:

1. **Windows completing that stage per hour**, sustained.
2. **Failure rate**, grouped by cause.
3. **p50 / p90 / max wall clock** for that stage.

Plus the end-to-end rate: windows reaching a `room_emotion_window` row per hour. E8 §5 predicts a
structural ceiling of **12 an hour** set by emotion's system-wide `LIMIT 1` on a `*/5` cron. Confirm or
refute that number against observed behaviour — it is the most consequential figure in the programme
right now, and it was read from source, never measured.

## SEQUENCE

**Step 0 — snapshot BEFORE you change anything.** To `scratch/E9-BEFORE-14-SEP-2026.json`:
`room.id, room.name, room.transcript_enabled` for **all 13 rooms**; `bench_window` counts by state;
count with `clip_r2_key NOT NULL`; `room_diarize_window` and `room_emotion_window` row counts;
`scribe_job` counts by kind and status. **This file is how the rooms get restored. Write it first and
verify it is on disk before step 1.**

**Step 1 — switch Transcript ON** for every room holding backlog windows. Today that is the 9 rooms in
`bench_window`; `room_ymch4bxu` and `room_2qe955hy` are already on. Prefer the admin route or UI if one
exists; a direct `UPDATE room SET transcript_enabled = TRUE WHERE id IN (…)` is acceptable and is the
only production write this brief authorises. Record the exact statement you ran.

**Step 2 — confirm the drain is actually live.** Do not assume the redeploy landed. Watch for the first
window to gain a `clip_r2_key`, or for a `room_window` job to appear. **If nothing has drained 15
minutes after the flags are set, stop and report** — that is a finding, not a delay.

**Step 3 — observe for 30 minutes**, sampling every 5 minutes into
`scratch/E9-SAMPLES-14-SEP-2026.json`: per sample, timestamp, windows by state, clips written,
diarize rows by state, emotion rows by state, jobs by kind and status, and which rooms the drained
windows belong to.

**Step 4 — interim report at T+30, then STOP and wait.** Do not run the full two hours on your own
judgement. The Orchestrator rules on whether to continue.

**Step 5 — restore. This runs even if the run fails, is abandoned, or you run out of context.**
Set `transcript_enabled` back to exactly the values in `E9-BEFORE`. Confirm all 13 rooms match the
snapshot and say so explicitly in the report. **Clinic opens tomorrow. A room left switched on is the
one way this task can do harm.**

## WHICH ROOM GOT WHICH SLOT — record it

This run is also the first live test of E8 §3. With 9 rooms Transcript-on and a static backlog, the
selector's `closed_at DESC` will rank rooms against each other exactly as the model says. **Log the
room of every window drained, in order.** If two or three rooms take every slot, that is the starvation
finding confirmed on production data rather than in a simulation — and it is worth more than the
throughput number.

## ALLOWED

- The `UPDATE room SET transcript_enabled` in steps 1 and 5. Nothing else may write.
- Read-only SQL, freely, including today's data.
- Reading source at `fe021a3`. Scratch files under `docs/handoff/scratch/`.
- MCP read tools (`scribe_health`, `scribe_job_list`).

## DO NOT

- Do **not** change code, migrations, `vercel.json`, or any env var. `AUTO_DRAIN_BATCH_LIMIT`,
  `AUTO_DRAIN_MAX_AGE_HOURS` and the sort order in `lib/stt/auto-drain.ts` are all off limits — the
  shipped configuration is the experiment.
- Do **not** enqueue, submit, retry or cancel a job by hand. The crons do the work; you watch.
  One exception: if the drain works but diarize or emotion never fires, you may submit **one** job of
  the stalled kind to establish whether the stage is broken or merely unfed — report it as a manual
  probe, clearly separated from the observed rates.
- Do **not** deploy, push, merge or open a PR.
- Do **not** quote transcript text, speaker names or any clinical content. Counts, timings, ids,
  room ids and error strings only.
- Do **not** leave any room switched on at the end.

## VERIFY — PASS / FAIL / UNVERIFIED each

- V1 `E9-BEFORE` was written before any room was switched.
- V2 The drain ran unattended through the cron, not through a door you opened.
- V3 Every "done" has both a diarize row and an emotion row (E8 §6.3: end-to-end keeps the emotion row,
  and each stage is also reported separately).
- V4 `AUTO_DRAIN_BATCH_LIMIT` was never set and the sort was never touched.
- V5 **All 13 rooms are back to their snapshot values**, confirmed by a read after the write.
- V6 Router `/healthz` 200 before and after.

## OUTPUT

`docs/handoff/ETA-E9-LIVE-RUN-INTERIM-14-SEP-2026.md`

1. Line 1: did the pipeline move a window end to end? YES / NO / PARTIAL, and how far it got.
2. The per-stage numbers, as far as 30 minutes supports them. Say plainly where the sample is too
   small — an honest "n=4, not a rate" beats an extrapolation.
3. The drained-window room order (§ above).
4. V1–V6.
5. Failures by cause, with the real error string.
6. Flags: anything you could not measure, anything you assumed, anything that surprised you.

**Cap: 110 lines.** Raw samples stay in the scratch JSON.

## KNOWN FACTS

- DB string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf`. Read it, use it, never
  print it, never copy it into the repo. Your `APP_DATABASE_URL` is also live (your F8) — either is fine.
- Live state before this run, measured by the Orchestrator, cut at 14 Sep 00:00 IST:
  `closed` **1,291 with 0 clips** · `transcribed` 15 with 15 clips · `open` 183 · `failed` 1 ·
  `room_diarize_window` 15 all time · `room_emotion_window` **0 all time** · `transcript_enabled` TRUE
  on **2 of 13** rooms · `stt_subject_job` **229 `asr` queued**, 3 done, 1 failed.
- `clip_r2_key` has exactly one writer, `roomWindowPrepare` at `lib/stt/room-drain.ts:643`, reached only
  through `drainRoomWindow`. That is why nothing downstream has ever run.
- Diarize takes 4 per tick (48/h), emotion 1 system-wide per tick (12/h), drain 1 per tick (12/h). Three
  queues in series on `*/5`.
- The diarize scan has **no age limit and takes oldest first** (`diarize-job.ts:141`). Anything that
  gains a clip becomes diarize-eligible within two ticks.
- Router is `/healthz` on 8083, not `/health`. Docker is down on the Mini; you do not need it.
- `room_2qe955hy` is named "Home Office" and may not be clinic audio. For a throughput measurement that
  is fine and worth noting, not excluding.
