# ORDER — yoga-drain — can Yoga actually take load off the Mini?

V asked whether Yoga can speed this up. I do not want to answer him from what we concluded before,
because what we concluded before was narrower than the question he is asking.

## What we established, precisely
Yoga was closed as a **diarization** producer: 10.4x slower, and 8 of 8 boundary differences
arm64 vs x86_64 against a 43% base rate. That verdict stands for diarization and I am not
reopening it.

**But the drain is not only diarization.** It is fetch, diarize, transcribe, and write. Nobody has
shown which of those dominates, and Yoga was never ruled out for the others. Both Indic engines
are installed there byte-identical to the Mini's, healthz is reachable in under 60 ms, and the
18-pair edit distance came back 0.0000 — which your own pane correctly called **unfalsified
rather than vindicated**, because every one of those pairs was Yoga's engines on Yoga's own clips.

## Task 1 — where does the time actually go
From the drain now running, break down **per-window wall-clock**: fetch, diarize, transcribe,
write. Percentages and absolute milliseconds. This is the whole question — if diarization is 90%
of it, Yoga cannot help and I will tell V that plainly. If transcription is a large share, the
split is real.

## Task 2 — kill or confirm the engine-equivalence claim
The test that was never run: **take a clip that originated on the Mini, send it to the Mini's
engine and to Yoga's engine, compare the returned text.** That is the comparison that matters and
the 0.0000 result does not stand in for it. Use clips from the real corpus, not 30 s synthetic
ones, and use the multipart POST path — healthz is a few bytes and proves nothing about MTU.
Your pane already named torch as first suspect; this is how you find out if it deserves it.
Report edit distance distribution over at least 20 real pairs, and the count of pairs that differ
at all.

## Task 3 — only if 1 and 2 both come back favourable
Say what a split would look like: Mini diarizes, Yoga transcribes. What moves over the wire, how
much of it, and what the expected speedup is given the measured breakdown. **Do not build it.**
Say plainly if the wire cost eats the gain.

## Guard rails
The drain keeps running and keeps priority — do not stop it to run this, and do not let the
comparison compete with it for the Mini's engines. If the measurement would disturb the drain,
queue it and say so. Watchdog still governs. `ETA_MAX_INFLIGHT` stays 3.

## Output
Task 1 breakdown, Task 2 distribution, Task 3 only if earned. A one-line verdict:
**Yoga helps / Yoga does not help / still unknown and here is what would settle it.**
CAP 250 words.
