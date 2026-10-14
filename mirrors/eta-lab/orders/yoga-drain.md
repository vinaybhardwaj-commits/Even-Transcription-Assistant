# ORDER — yoga-drain — 20 Sep 06:20 IST

My last two messages reached you truncated at the front. From now on I will send you a one-line
pointer to a file like this one, and you read the file. Ignore any fragment you received earlier.

## 1. Yes — prune the Docker volumes. Do it first.
1,519 orphaned volumes holding 62.4 GB, 1,198 of them created on 19 Sep by test harnesses
running `docker rm -f` without `-v`. That is our own debris and it is the single largest
reclaimable item on a box sitting at 412 MB free swap. Prune it.

Two conditions:
- Confirm nothing is running that owns a volume you are about to remove. `docker ps` first.
- Report free space before and after, and the count actually removed.

Then fix the cause so it does not come back: whatever harness calls `docker rm -f` should call
`docker rm -fv`. Find it, name the file, and say whether it is a one-line change. Do not make the
change yet — tell me where it is.

## 2. The concurrency question, restated properly
You were right that the plist and the running process both already say `ETA_MAX_INFLIGHT=1`, and
right not to restart on a fragment. I was not asking you to confirm the value. I am asking for an
ACTIVE LOAD TEST: what happens to throughput and to the box when that number is 2 instead of 1.

The code default in `router_server.py:87` is 3. The live value is 1. On top of it
`_ROUTE_SEM = asyncio.Semaphore(1)` at line 121 serialises whole /route calls. We measured route
at 8.3x slower than whisper alone — 62 serialised calls against 1 — so this may be the single
biggest throughput lever we have, and it costs nothing to find out.

Method:
- Same clip every time, so the numbers are comparable. Measure wall-clock per window.
- Run at `ETA_MAX_INFLIGHT=1`, then 2, then 3, restarting the router between each with
  `launchctl kickstart -k gui/501/com.vinaybhardwaj.eta-router` and confirming
  `http://127.0.0.1:8083/healthz` returns 200 before you start timing.
- Stop the moment `diarize_ms` crosses 400 or swap-used starts climbing.
- Report throughput at EVERY level, and the highest that held — not only the one that broke.

Restarting is safe right now: nothing is recording anywhere. `scribe_sessions status=recording`
is empty, it is early Sunday, the clinic is closed. The three rooms showing `session_open: true`
are stale opens from Friday. You are not interrupting live clinical work.

Assume the 1 was set deliberately and may have been tried and reverted — memory pressure here is
real. A degradation at 2 is a finding to report plainly, not a failure. If 1 turns out to be
correct, say so and I will leave it.

Leave the plist at 1 when you finish, whatever you find. I set the final value deliberately.

## 3. Do the prune BEFORE the load test
62.4 GB back changes the memory and disk picture the test runs against. Measuring the ceiling on
a box that is artificially starved gives us a number we would have to throw away.

## Constraints
Counts and timings only. No transcript text, clinician or patient names, or room labels.
Post as `docs/handoff/ETA-MINI-DRAIN-CEILING-20-SEP-2026.md`.
