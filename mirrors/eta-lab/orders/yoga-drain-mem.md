# CORRECTION — the memory premise of your ramp was wrong — 20 Sep 07:05 IST

I told you swap was nearly exhausted and to treat memory as the binding constraint. I measured it
properly just now and that was wrong. Correcting it before it makes you stop your ramp early on a
signal that means nothing.

## What is actually true

- Physical RAM: **24 GB**.
- `memory_pressure`: **51–52% free**, stable across repeated readings minutes apart.
- **Swap-used DELTA: ZERO.** 37,025.19 MB at t0 and 37,025.19 MB several minutes later. Not one
  megabyte moved.
- Pageins 483.5M against pageouts 2.5M — a ~190:1 read-to-write ratio. Almost nothing is being
  written to swap.
- Resident totals: indicconformer 2.62 GB, sravaani 1.97 GB, a python process 2.68 GB,
  whisper-server 106 MB, ollama 80 MB (idle, no model loaded), router 120 MB across 5 procs.
  The whole ETA stack is about 5 GB of 24 GB.

The "37 GB used / 600 MB free" figure is a stale high-water mark. macOS grew those swap files
during some earlier peak and has never shrunk them. It is exactly the class of lying metric we
already documented on this box, and I walked straight into it. My error, not yours — you reported
what you read.

## What that changes for you

Memory is NOT the constraint. There is real headroom. So:

- Do not stop the ramp on absolute swap-used or on swap "free". Both are meaningless here.
- The stop conditions are now: `diarize_ms` at or above 400, OR a genuine swap-used DELTA that is
  climbing between readings (take two readings at least 60 s apart and compare — a single absolute
  number tells you nothing), OR `memory_pressure` free % actually falling across readings.
- Push the ramp further than I originally implied. Go to 4, and if 4 holds cleanly, try 6. The code
  default is 3 and we are running 1, so the useful answer may well be well above where I told you
  to stop.
- I expect `ETA_MAX_INFLIGHT=1` to turn out over-cautious. Do not let that expectation bias the
  measurement — if it degrades at 2, report that plainly and I will keep 1.

## Unchanged

Still leave the plist at 1 when you finish; I set the final value. Still restart freely — nothing
is recording. Still report throughput at every level, not only the level that broke. Counts and
timings only, no transcript text, names or room labels.

One housekeeping note: a stray `memcheck.sh` of mine may still be running under your box. Ignore
it; it is mine and it is harmless.
