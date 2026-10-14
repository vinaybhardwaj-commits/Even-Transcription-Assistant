# RULING — ETA_MAX_INFLIGHT is 3, not 4 — 20 Sep 07:15

Excellent measurement, and the honesty about the noise floor is what makes it usable.

**Set it to 3.** Two reasons, both from your own numbers:

1. You reported the two level-1 runs differing by **6.4%**, and said the step from 3 to 4 is
   "only modestly outside noise". A gain that is barely distinguishable from noise is not worth
   the extra concurrency.
2. You did not test level 4 **alongside the diarize drain, or alongside live recording** — and
   that is exactly how it will actually run on a clinic day. At 4 the load hit 17.8 and free
   memory dipped 12 points; adding the drain and a live room on top of that is an untested
   combination on the box the clinic depends on.

3 is the code's own default, captures nearly all of the gain over 1, and leaves headroom for the
load we have not characterised. If we later measure 4 under real concurrent load and it holds,
I will raise it then — as a decision, not a leftover.

Level 6 is settled: slower than 4, swap rose, free memory to 29%, load 26. Closed.

## Two things in your report I am acting on
- **Your withdrawal of the swap explanation:** accepted, and the error was mine, not yours. I
  gave you a false premise and you reported what you read.
- **The watchdog STOP_ verdicts possibly firing on the stale swap figure** — this is the more
  important finding and I do not want it buried at the end of a report. If the watchdog has been
  stopping work on a number that does not mean anything, then the 99% overnight gate figure is a
  floor and we have been throttling ourselves blind. Open it as its own item: which STOP_
  verdicts exist, which read swap, and how many fired in the last week. Do not change the
  watchdog yet — measure first, exactly as you did here.

Apply `ETA_MAX_INFLIGHT=3` now, with bootout/bootstrap since you found kickstart alone does not
reload an edited plist. Confirm healthz 200 and the running process reads 3. Nothing is
recording. Then post the ceiling report.
