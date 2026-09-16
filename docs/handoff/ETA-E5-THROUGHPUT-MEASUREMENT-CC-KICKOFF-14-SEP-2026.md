# ETA-E5 — measure the room-window pipeline's real service rate · CC KICKOFF · 14 Sep 2026

Ordered by R4 of `ETA-E4-RULING-STARVATION-CAP-AND-THROUGHPUT-14-SEP-2026.md`. Read that first.

## GOAL

Produce three numbers, measured end to end on real backlog audio:

1. **Sustained windows per hour** the room-window pipeline completes at shipped concurrency.
2. **Failure rate**, with reasons grouped.
3. **p50 / p90 / max wall clock**, enqueue → rows written, broken down by stage.

Those three numbers set `AUTO_DRAIN_BATCH_LIMIT` and decide whether `ROOM_AUTO_DRAIN_ENABLED` can go
on at all. Nothing else in this brief matters as much as getting them honestly.

## WHY NOW

Today is a holiday. **No room is recording.** The flags `ROOM_DIARIZE_ENABLED=1` and
`EMOTION_ENABLED=1` were created in Vercel today and did not exist before — the pipeline has
therefore never run in production. 1,378 closed grid-aligned windows from 09–13 Sep are sitting
unprocessed. Clean load, real audio, no patient impact. This window will not come again.

## KNOWN FACTS (measured by the Orchestrator, read-only, do not re-derive)

- `bench_window` closed + grid_aligned, last 7 days: **1,378** across **9** rooms
  (334 / 250 / 160 / 147 / 139 / 124 / 113 / 76 / 35).
- `room_diarize_window`: **15 rows all time**, all state `ok`. `room_emotion_window`: **0 rows all time**.
- `scribe_job` last 7 days: 13 rows — 10 `failed`, 3 `done`, across kinds
  `emotion_window`, `diarize_window`, `room_window`, `transcribe_range`.
- Peak live load is **7–9 concurrent rooms, 28–32 windows an hour**, not the 6/24 the E4 model assumed.
- `auto_drain_refused_reason` is NULL on all 1,507 rows — auto-drain has never selected anything.
- Engines: Sarvam is the only paid API. Everything else is the Mini — whisper 8080/8081, indic 8082,
  **route 8083 (`/healthz`, not `/health`)**, status 8084, sravaani 8085, emotion 8086, diarize 8001.
- Router `results` IndexError was fixed today in `~/eta-router/router_server.py`; restarted under
  launchd, `/healthz` 200. If you hit an IndexError there, say so — it means the fix regressed.

## SCOPE — exactly this

1. **Capture the sample first, to a file, before running anything.**
   Select **40** closed grid-aligned windows: **at least 4 distinct rooms**, **at least 2 distinct
   days**, 10 per room maximum. Write the window ids + room + `end_ms` + `closed_at` to
   `docs/handoff/scratch/E5-SAMPLE-14-SEP-2026.json`. The measurement is against *that* list; if a
   later step silently processes a different set the numbers are worthless.

2. **Identify the path.** Name the exact function and file that `auto-drain.ts` would enqueue
   through, and confirm the manual route you are about to use enters at the same point. Put the
   file:line in the report. If the manual path and the auto path diverge, **stop and report that** —
   it is a bigger finding than the throughput number.

3. **Run the 40 through it** at shipped concurrency and defaults. Do not tune anything to make the
   number look better. Record per window: enqueued at, started at, finished at, terminal status,
   error text if any, and the stage timings the job already records (`timing_json`).

4. **Verify completion by rows, not by status.** A window counts as done only when
   `room_diarize_window` has a row for it in a terminal success state **and** `room_emotion_window`
   has a row for it. `lib/jobs/kinds/emotion-window.ts:191-193` states the standing rule —
   *THE COUNTS ARE THE ROWS* — and it applies to this measurement too. A `scribe_job` marked `done`
   with no rows behind it is a **failure** for our purposes; count it separately and say so.

5. **Group the failures by cause.** Given 10 of the last 13 jobs failed, expect failures. The
   breakdown matters more than the headline rate: engine timeout, R2 fetch, tunnel, schema, OOM,
   unhandled. One line each with the real error string.

6. **State whether the rate is stable or degrading** across the 40 — first 10 vs last 10. If the Mini
   heats up or a queue backs up, the sustained number is the last 10, not the mean.

## ALLOWED CHANGES

- Read-only SQL, freely.
- Scratch files under `docs/handoff/scratch/`.
- Running existing jobs through existing paths with existing flags.

## DO NOT

- Do **not** change any application code, migration, flag, env var or `vercel.json`.
- Do **not** set `ROOM_AUTO_DRAIN_ENABLED`. Do **not** change `AUTO_DRAIN_BATCH_LIMIT`.
- Do **not** touch the sort order in `lib/stt/auto-drain.ts`. R2 of the ruling forbids it.
- Do **not** deploy, push, merge or open a PR.
- Do **not** tune engine parameters, concurrency, or model choice to improve the number.
- Do **not** quote or paste any transcript text from real room audio anywhere in the report —
  counts, timings, ids and error strings only.
- Do **not** process more than the 40. The backlog's disposition is V's decision, not this task's.

## WHAT TO VERIFY (state each explicitly as PASS / FAIL / UNVERIFIED)

- V1 The 40 processed are byte-for-byte the 40 in the sample file.
- V2 The entry point used is the same one `auto-drain.ts` enqueues through (file:line).
- V3 Every "done" has both a diarize row and an emotion row.
- V4 Flags were on for the whole run and unchanged by you (report their values, **names only for
  anything secret-shaped — never print a secret's value**).
- V5 No room was recording during the run.
- V6 The router `/healthz` returned 200 before and after.

## OUTPUT

`docs/handoff/ETA-E5-THROUGHPUT-REPORT-14-SEP-2026.md`. Structure:

1. The three headline numbers, first, in four lines.
2. V1–V6 verdicts.
3. Per-stage timing table (p50/p90/max).
4. Failure breakdown by cause, counts + one real error string each.
5. First-10 vs last-10 rate.
6. Flags — anything you could not measure, anything you had to assume, anything that surprised you.

**Cap: 120 lines.** Raw per-window data goes to `docs/handoff/scratch/E5-RAW-14-SEP-2026.json`, not
into the report.

If the pipeline cannot process even one window end to end, that is a complete and valuable answer —
report it at line 1 with the first real error and stop. Do not spend the session debugging it; a
Debugger gets that separately.
