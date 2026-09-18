# ETA-E13 — we cannot tell a quiet room from a dead microphone · 14 Sep 2026 · Orchestrator

Read-only measurement by me, while `scribe`, `scribe3` and `ETA-Refuter` were in flight on other work.
This does **not** block E11. It changes what E11 means.

## 1. The measurement

`bench_chunk` carries `peak_level` and `avg_level`. Across **5,311 chunks all time, 140 carry a level.**

| day | chunks | with a level |
|---|---|---|
| 14 Sep | 318 | **0** |
| 13 Sep | 534 | **0** |
| 12 Sep | 1,033 | **0** |
| 11 Sep | 816 | **0** |
| 10 Sep | 987 | **0** |
| 9 Sep | 697 | 2 |
| 25–26 Aug (bring-up) | 138 | 138 |

**Since 10 Sep — every clinic day we have — 3,688 chunks have been written and not one carries an audio
level.** The columns exist and were populated during the August bring-up, then stopped.

## 2. Why this matters tonight, specifically

Tonight's root cause says 21 of 25 windows "contained no speech". That rests on Whisper's VAD reporting
zero speech segments, and on a direct probe showing Whisper correctly transcribes a control file. Both
are sound. But:

> **A dead, muted or unplugged microphone produces exactly the same evidence as a quiet room.**
> Whisper's VAD cannot distinguish them. The recorder's own level measurement is the only independent
> signal that could — and it has not been recorded since 10 Sep.

So the honest statement of tonight's finding is **"this audio contained no detectable speech"**, not
"the room was quiet". The second is an interpretation, and we currently have no way to check it.

The 8 parked windows are consistent with either reading: 7 are `room_2qe955hy` ("Home Office") on
13 Sep between 12:15 and 14:15, which is plausibly a genuinely empty room. The 8th, `bw_ebzkeda3_…`,
is from **22 Aug with no clip** — a historical failure, unrelated to tonight. **That corrects E10 §4.1:
the two drain calls after 18:53 did not strand an 8th window.**

The only levels we do have, from 25 Aug in that same room: median peak **0.0079**, max 0.5371. Mostly
near-silence with occasional loud chunks — which is what an empty room with someone passing through
looks like, and also what a failing microphone with occasional handling noise looks like.

## 3. The uncomfortable part, which is mine to own

E11 — which I approved tonight — makes a silent window finish as `transcribed` with an `stt_silence`
cue instead of failing loudly.

**For a genuinely quiet room that is correct and overdue. For a dead microphone it converts a visible
failure into an invisible one.** Before tonight, a room whose microphone died produced
`whisper_unavailable` three times and parked the window — ugly, wasteful, and *noticeable*. After
tonight it produces a tidy silent window and a green day view.

I am not withdrawing the approval. Treating silence as an outage was worse: it burned attempts, it
mislabelled the cause, and it would have put 21 of 25 real windows into a paid engine if the branch had
gone the other way. But the consequence is real and it lands on a clinical capture system:

> **The `stt_silence` cue is now load-bearing for detecting a dead microphone, and there is no
> telemetry behind it.**

## 4. Rulings

**R-E13a. E11 still ships.** The Refuter's verdict stands on its own merits; this finding is not a
reason to hold it. But the E11 report and the `stt_silence` cue's own documentation must say that a
silence cue means *no detectable speech*, not *an empty room* — the two are different claims and only
one of them is evidenced.

**R-E13b. Restoring audio levels is now a priority, not a nicety.** It is the difference between being
able to audit "was this consultation actually captured" and not being able to. Scope: find why the
recorder stopped sending levels (or the API stopped storing them) some time between 26 Aug and 10 Sep,
and restore it. Both the browser kiosk and the native Room Recorder are in scope. **Not tonight** —
nobody should touch the recorder at 20:30 with clinic in the morning.

**R-E13c. Once levels are back, a silent window must record the level it saw.** A silence cue that
carries "peak 0.0000 across the whole window" is a dead-microphone alarm. One that carries
"peak 0.31, no speech segments" is a quiet room. Same cue, two very different clinical meanings, and
one number separates them.

**R-E13d. Until then, treat every silent-window statistic as unvalidated.** Including tonight's
21-of-25. It is the right explanation of the *failures*; it is not yet proof about the *rooms*.

## 5. What I have NOT established

- Whether any specific microphone is actually failing. **Nothing here says one is.** This is about the
  absence of a signal, not the presence of a fault.
- When exactly levels stopped, or whether the cause is recorder-side or API-side. The gap is 26 Aug →
  10 Sep and neither end is pinned.
- Whether the native Room Recorder and the browser kiosk behave the same way here. They differ in how
  they cut audio (sample count vs timer), so they may differ in this too.

Orchestrator. Read-only queries by me. No subagents. No code, flag or service touched.
