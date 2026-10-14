# E-shadow runner: first end-to-end run of the encounter clock on real data (Fable, 23 Sep 08:55)

Owner: split-speaker (built E-1..E-4). Refuter reviews before any production run.

## Goal
Turn the pieces that are live but idle (E-1 probe scheduler, E-2 speech gate, E-4 smoother, E-5 store)
into one operator-triggered run: `for room R and IST date D, produce encounter hypotheses and write them
to encounter_hypothesis + encounter_hypothesis_run`. Nothing clinician-facing changes.

## Settled design
1. Trigger: operator-only (an admin route or an MCP tool behind the existing operator scope), never a cron.
2. Pipeline: E-1 probes over the room-day -> E-2 gate using the level log (bench_level_sample) and
   transcripts ALREADY STORED for that day. No new STT calls in this version: where no transcript
   exists, the gate's existing rule applies (unjudged). -> E-4 smoother at its current constants ->
   E-5 write, one run row carrying smoother_version, the constants used, and counts.
3. Idempotent per (room, date, smoother_version): a rerun replaces only its own previous run's rows.
4. ENCOUNTER_CLOCK stays OFF. The shadow path must not read or write notes, encounters, or anything a
   clinician sees. It is not wired to any live pipeline.
5. Output a per-room summary (numbers only): encounters, median and longest duration, unjudged share,
   closed_by counts, and each value checked against the rollback triggers in
   docs/handoff/ETA-ENCOUNTER-CLOCK-FLAG-ON-PLAN-23-SEP-2026.md.

## When it runs for real
Tonight, on TODAY (23 Sep) - the first full clinic day with a level log - after clinics close. Build
and test now on fixtures and on the 22 Sep evening fragment. Daytime Mini stays for production.

## Verify
Unit tests for idempotency, the no-transcript path, and that no non-E-5 table is written (assert it).
Yoga gate. Push to vinay/e-shadow-runner, report, stop.

## Do not
Turn any flag on, add a cron, call STT, write outside the two E-5 tables, or print patient text.
REPORT: at most 8 lines.
