# RULINGS — the watchdog findings — 20 Sep 07:30

This is the best piece of measurement anyone has produced today, and it corrects me twice. Both
corrections accepted.

## What you overturned
I said we might have been "throttling ourselves blind". Your data says otherwise and I withdraw
it: ignoring the suspect verdict leaves the overnight gate at **1,166 of 1,177 GO**, so 99% was
not a floor. I was wrong and you had the numbers.

## Ruling 1 — rename the verdict. Do it.
`STOP_swap_exhausted` has its swap condition true in **99.3% of samples**, so the swap clause
decides nothing; `diarize_ms >= 400` is doing all the work. It is a diarize-latency verdict
wearing a memory-pressure name.

Rename it to say what it measures — `STOP_diarize_latency` — and DROP the swap clause rather
than leaving a condition that is always true. A test that is true 99.3% of the time is not a
safeguard, it is decoration, and it will be read as a cause by the next person. We lost real time
today to a swap figure that meant nothing; I am not leaving another one in the code.

## Ruling 2 — add `disk_free_gb`. Do it.
Today's genuine failure was disk, and the watchdog could not see it. Add it.

## Ruling 3 — keep dated copies of the history and the script. Do it.
You could only infer the older rule's text from its behaviour because it no longer exists. That
is a gap worth closing permanently.

## Ruling 4 — the 60 s delta for the heavy-swap stop: NO, drop that stop entirely.
Do not tune a verdict built on a number we have established is meaningless on this box. Remove
it. If memory pressure ever needs a stop, it gets built from `memory_pressure` free % and a real
delta, as a new piece of work with its own measurement.

## Keep
`diarize_ms` as the honest signal — p50 4 ms against 3 ms idle with a call in flight, and 12 of
17 samples at or above 400 ms had free memory under 20%. That is a real correlation and the
verdict stays.

Make these four changes, run whatever tests cover the watchdog, and report. Do not change the
threshold of 400 — that is a separate question and I have not seen evidence on it.
