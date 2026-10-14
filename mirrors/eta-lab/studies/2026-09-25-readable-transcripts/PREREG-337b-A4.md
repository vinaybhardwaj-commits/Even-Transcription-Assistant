# READABLE TRANSCRIPTS 337b: addendum A4 (linker, 25 Sep 2026; the git commit time is the timestamp): `--workers N`, several windows translated at once; frozen BEFORE the code change; nothing restarts before eta-refuter-2's PASS

Addendum to `PREREG-337b.md` and A1 to A3. Reason: the sequential run (started 11:40 by V) does about 3 windows a minute, roughly 20 s a window and dominated by call latency; 2,626 windows would take about 14 hours, and the priority is readable transcripts today (ruling 337). **Only the way windows are scheduled changes.** Scope (T1, A2), route (T2), prompt, items and files (A1, A3), resume (A1.2), the order of submission (newest date first) and the checks stand.

## A4.1 The change
- `run` and the `run` command take `--workers N` (integer 1 to 16, default 1). **With N = 1 the behaviour is the sequential behaviour of v4, unchanged.** With N > 1 a thread pool translates up to N windows at once; each window is still translated by the same `translate_window` (batches of 25, line isolation, provider and model checks, 429/5xx backoff) and no window is split across workers.
- **Only the main thread collects results and writes files** (every flush, every count), in the order the windows were submitted, so there is one writer and no file-name race; the flush rule (every 10 windows and at the end, one file per room-day, provider and 400 k) is unchanged. A window that fails is a failure item, as now; an unexpected exception in any worker stops the run and is raised (nothing is swallowed).
- The call log is written under a lock (counts and statuses, never text).
- File creation retries with the next minute if the name was taken between the check and the create (`FileExistsError`), so two runs that both write into one room-day cannot overwrite each other or crash.
- `--max-windows N` still counts attempted windows in submission order.
- The preflight binds the new script commit and A4; it is re-run for it.

## A4.2 Restart (not part of the script)
Resume is by the annotation files (A1.2): a restarted run skips every segment already done. **V (or Fable) stops the sequential run and starts the new one; a window whose call is in flight at the stop is simply redone (nothing half-written is ever in a file: files are written whole, once).** The sequential run and a parallel run must not run at the same time.

## A4.3 Checks
Tests on invented data for: `--workers 4` gives exactly the same items and files' content as `--workers 1` on the same world; two windows really are in flight at once (a two-party barrier in the fake transport; a sequential implementation times out); `--max-windows` is respected; a failing window does not stop the others; an unexpected exception is raised; resume after a parallel run skips everything; the retry on a taken file name; workers outside 1 to 16 refused. Mutants with a control run. **eta-refuter-2's review and PASS of the new commit before any restart.** Suggested N = 8 (about 8 times the rate, so about 1.7 hours for the rest at today's per-window latency); OpenRouter's rate limits are handled by the existing backoff, and a 429 storm shows in the counts as retries.
