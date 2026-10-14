# ORDER — scribe3 — the backlog is not waiting to be diarized. It is waiting to be CLIPPED.

Your diagnosis reframes everything and I had it wrong to V. The line that matters:

> **2,513 of the 2,514 never-handled windows have no clip.** The app path only takes windows that
> already have a clip, so it is starved. 2,142 of those are older than 2 days. Its ~7 per hour is
> the trickle of newly clipped windows, not throughput.

And: **pid 20557 used 0.32 s of CPU in 2 h 27 m, sleeping, 0 sockets, log holds only `start`.** The
night-drain has diarized **nothing**. Every one of the 166 rows was written by the app's own
`diarize_window` job. I told V the drain was working and it has never processed a single window.

So the bottleneck is **clip production**, not diarization, and no amount of concurrency, closed-hours
or Yoga fixes it. This is now the only question that matters.

## Questions, in order
1. **What produces `clip_r2_key`?** Name the job, route or script, and where it is triggered from.
2. **Why are 2,513 windows missing one?** Did the producer die, never run for these, run and fail,
   or is it gated on something — a flag, a room setting, a session state, an age cutoff, a
   recording still being open? **2,142 are older than 2 days**, which smells like it stopped rather
   than never started. Find when clip production last succeeded and what changed around then.
3. **Can the backlog be clipped now?** Is the source audio still in R2 for those windows, or has
   anything expired or been swept? If the audio is gone for some, count them — that would mean
   part of the backlog is unrecoverable and V needs to know tonight, not next week.
4. **What does clipping cost?** Per window, and for 2,513. If it is cheap the whole picture changes
   and 6 nights becomes optimistic-but-real; if it is expensive it is a capacity decision for V.

## Also, two corrections to carry
- The night-drain is asleep until 21:30 and it is now past that, so it should finally be working —
  **check whether it has actually claimed anything since the gate opened**, and if it is still idle
  say so, because a drain that cannot find clipped work will stay idle whatever the hour.
- I ordered it started at 12:35 outside its closed-hours window. yoga-drain flagged that correctly
  and stopped rather than guessing. That was mine, not a mystery.

## Not allowed
Do not start a bulk clip run tonight. Do not change the closed-hours gate. Do not raise concurrency.
Diagnose and cost it; I want V to decide with a number in front of him.

## Output
The producer, the reason, recoverability with counts, and the cost. CAP 250 words.
