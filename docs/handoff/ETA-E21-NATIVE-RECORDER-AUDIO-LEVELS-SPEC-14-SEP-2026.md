# ETA-E21 — the native recorder must report audio levels · SPEC · 14 Sep 2026

Read `ETA-E15-VAD-AND-LEVELS-14-SEP-2026.md` and `ETA-E14-E15-RULINGS-AND-SCRIBE-ANSWERS-14-SEP-2026.md` §2.

**This is the highest-consequence change in the queue.** The native recorder is what runs in clinic
rooms. A recorder that fails to record is infinitely worse than a recorder without levels. Everything
below is shaped by that.

## 1. THE FACT

`bench_chunk.peak_level` / `.avg_level`: **0 of 4,405 native chunks, ever, 27 Aug to 14 Sep.**
140 of 140 browser-kiosk chunks have them. The API is correct and stores levels whenever they arrive.
The browser kiosk computes and sends them correctly. **No build ever broke** — the native recorder has
never sent them, and the fleet migrated to native between 27 Aug and 10 Sep.

My E13 framing ("levels stopped around 10 Sep") was wrong, and the correction matters here: this is not
a regression to undo, it is a capability the native path never had.

## 2. WHY IT MATTERS

Without a level, **a dead microphone and a quiet room are indistinguishable.** Whisper's VAD reports no
speech for both. Since E11, a silent window finishes cleanly as `transcribed` and is never re-picked —
so a failed microphone in a consulting room now produces a tidy green day view.

A silence cue carrying "peak 0.0000 across the whole window" is a dead-mic alarm.
One carrying "peak 0.31, no speech" is an empty room. **One number separates them and we record neither.**

## 3. RULED: option (a), the additive one

`scribe3` named two routes. I am ruling between them rather than leaving it open:

- **(a) Measure levels in the production capture path and carry them through the chunk manifest and
  upload adapter** (`PiecePipeline.swift`, `RoomEngine.swift`). **Build this one.**
- **(b) Switch `main.swift` to the existing level-correct pipeline.** **Do not.**

The argument for (b) is that the level-correct pipeline already exists and is tested. That is exactly
what makes it dangerous: *tested* means its unit tests pass, not that it has ever recorded a clinic
day. The shipped path has months of real capture behind it. **We are adding a measurement, not changing
how audio is captured** — and if the two ever have to be reconciled, that is its own round with its own
evidence.

Add the fields. Do not move the pipeline.

## 4. HARD CONSTRAINTS

- **Capture must not be able to fail because of a level.** If level computation throws, is slow, or
  returns nothing, the chunk is still recorded and still uploaded — **without** the level. A missing
  level is a gap in telemetry; a missing chunk is a lost consultation. Make that impossible by
  construction, not by a try/catch someone can later remove.
- **The manifest and the upload adapter must tolerate a chunk with no level**, so a mixed fleet works
  during rollout and an older recorder is never rejected.
- **No change to chunk boundaries, durations, sample handling or upload ordering.** If the diff touches
  any of those, stop and report — the 300 s piece boundary is load-bearing for window close timing and
  for every measurement made today.

## 5. ROLLOUT — staged, and not by me

1. Build and test locally.
2. **One room first.** Verify with a query that its chunks carry levels and that its windows still
   close on the grid exactly as before.
3. Fleet self-update only after that room has a full session with no regression.

**Do not deploy. Do not trigger a fleet self-update.** Report the build and the verification plan;
the rollout decision and its timing are V's, and they are a clinic-day decision.

## 6. VERIFY

- **V1** A native chunk carries `peak_level` and `avg_level`, readable in `bench_chunk` by a query you
  show.
- **V2** **Capture survives a level failure.** Force the level path to throw and prove the chunk is
  still produced, still uploaded, still stored — with a null level. This is the most important test in
  the round.
- **V3** Chunk boundaries, durations and count are byte-for-byte unchanged against a recorded fixture.
- **V4** The API and manifest accept a chunk with no level (mixed fleet).
- **V5** The browser kiosk is untouched and still sends levels.
- **V6** The values are plausible against the only reference we have — the 25 Aug browser-kiosk
  distribution, median peak 0.0079, max 0.5371 — on comparable audio. **A level that is always 0, or
  always 1, passes V1 and means nothing.**
- **V7 Mutation check** where the Swift toolchain allows it; say plainly which mutations you could not
  run rather than reporting a number you did not measure.

## 7. NOT IN THIS ROUND

- The dead-mic **alarm** itself. Getting the number recorded comes first; deciding what threshold
  raises an alert, and to whom, is a clinical-operations decision and its own round.
- Backfilling levels for the 4,405 chunks already stored. They cannot be recovered without the audio,
  and the audio is in R2 — possible, expensive, and not now.
- The VAD model's calibration. Separate question, separate round.
- `apps/room-recorder/.build` is currently in a bad state (a `TestingMacros` plugin failure from
  14 Sep). **Clear it before you start**, and say so in your report.

## 8. OUTPUT

`docs/handoff/ETA-E21-REPORT-14-SEP-2026.md` — diff by file and line count; V1–V7; the verification
plan for the one-room stage, written so someone else can run it. **Cap: 100 lines.**
Commit on green; **no push, no merge, no deploy, no fleet update.**
