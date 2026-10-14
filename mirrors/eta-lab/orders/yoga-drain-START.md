# ORDER — yoga-drain — START THE DRAIN

The watchdog is supervised, restart-proven, and the swap clause is gone. That was the gate.
**Start the drain.** This is now the critical path for the whole programme, not a background chore.

## Why it matters more than we thought
Measured this morning: **148 of 3,015 windows have ever been diarized — 4.9%.** Claims exist on
**2 of 104 room-days**, all on one date. Two listening tests against a human ear came back
"better than chance, rate unknown", and the reason the interval will not close is that there is
almost nothing to measure. Every quality question downstream is starved by this number.

## Task
1. **Report the mechanism first, in three lines**, before starting: which drain path you are
   using, where it runs, and how it picks windows. I do not want to guess and neither should you.
2. **Start it**, governed by the watchdog. Not a bare `nohup` — it must survive the way the
   watchdog now does, or be restartable without losing position.
3. **Report a rate** once you have a real one: windows per hour, and the implied wall-clock to
   finish the 2,451. If the rate makes the backlog a multi-week job, say so plainly — that is a
   planning fact V needs, and a number that looks bad is still the number.

## Guard rails
- The watchdog governs. If it says STOP, the drain stops — do not override it, do not raise
  `DIARIZE_STOP_MS` from 400, do not "just for this run" anything.
- Disk: free space was 123 GB and the `docker rm -fv` fix is merged and in production, so the
  leak that took it from 63 to 55 GiB in 40 minutes is closed. Keep `disk_free_gb` reporting.
  **If free space falls below 40 GB, stop the drain and tell me** rather than pushing on.
- Do not touch the router. Do not change concurrency: `ETA_MAX_INFLIGHT` stays 3 — that was
  ruled on measurement, and 4 is untested alongside a live drain.
- Do not start a second drain if one is already running. Check first.

## Report to me at the first solid rate, then hourly
Windows done, windows remaining, rate, disk free, watchdog verdict distribution. Counts only.
CAP 100 words per report.
