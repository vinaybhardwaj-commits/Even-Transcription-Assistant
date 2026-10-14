# ORDER — scribe3 — 20 Sep 06:20 IST

My earlier messages have been reaching panes truncated at the front. You get a file pointer from
now on. Ignore any fragment.

Your drain assessment is accepted in full, and the three findings you volunteered are worth more
than the ones I asked for. Acting on them in this order.

## 1. Commit the router's silent_skipped fix. Today. Before anything else.
You found it is LIVE but UNCOMMITTED in `~/eta-router`. That means the correctness of production
speech-detection currently exists only as bytes on one disk, with no history, no review and no
way to restore it if that box is rebuilt or that file is overwritten. We have spent this whole
session on the difference between "running" and "shipped" and this is the purest example of it.

Get it into git with a real message saying what it fixes: the old test asked "were there
segments" when the question is "did any engine run", so a window where the router never listened
was indistinguishable from one where engines listened and heard nothing. Include the test file if
`test_job_verdict.py` is also uncommitted.

Do not change the behaviour. It is live and it is right. You are recording it, not editing it.

## 2. The 277 open windows are the more interesting number
245 of them older than two days, never closed, and therefore invisible to every drain that will
ever run. That is not a drain problem, it is a window-lifecycle problem, and it means my 2,451
backlog figure is an undercount.

Tell me: what closes a bench window, why did these not close, and is it safe to close them now
retrospectively. Do not close any. I want to know what the rule is before anyone applies it to
245 rows, because a window closed at the wrong boundary produces a clip that is wrong for ever
and we would not find out until the transcript read strangely.

## 3. Arrivals exceed the cap — hold, do not raise
You are right that 410 arrivals against a cap of 288 a day means the pile grows no matter how
well the drain runs, and right that `AUTO_DRAIN_BATCH_LIMIT` 1 to 2 fixes it. Hold it.
yoga-drain is about to reclaim 62.4 GB of orphaned Docker volumes and then load-test the
router's `ETA_MAX_INFLIGHT` at 1 versus 2. Both knobs spend the same headroom, and raising two
at once on a box with 412 MB of free swap gives us a result we cannot attribute. You get the
headroom question answered first, then we raise yours deliberately.

## 4. Noted and agreed
Keep the auto-drain on — 0 failures in ~130 runs since 19 Sep 02:23 UTC, and the 23
`whisper_unavailable` were one 3-hour outage on 14 Sep, not a pattern.
Merge the app half and re-run the phrase-loop backfill after any big drain, not before.
The 10-of-70 scoped sample at ~324 windows and ~15 Mini-hours is the right shape for a first
real drain and I am likely to take it once the ceiling is known.

## Constraints
Counts, ids and timings only. No transcript text, clinician or patient names, or room labels.
Short report on the bus.
