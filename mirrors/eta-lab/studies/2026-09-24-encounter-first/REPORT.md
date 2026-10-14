# ENCOUNTER-FIRST: can the day tape be cut into consult clips before STT? (lx, 24 Sep, Part B)

**Short answer: yes, and it beats today's encounter clock by a wide margin on the one day we can score.**
Energy alone, restricted to the doctor's working span from the queue, finds **14 of 16** consults
(E-6 fusion: 3 of 16) at **61% precision** (E-6: 3/7), with median boundary errors of **5.0 / 3.0 min** (start / end).
It needs no transcript and no raw audio: the level log and the queue are enough to cut.

## Setup
- **Day and rooms.** 23 Sep, the 3 room-days with PQM truth: Cardiology OPD, OPD 3 and OPD 5.
- **Truth.** 16 consults from the live Metabase db 13 pull. Consults are assigned to rooms by voice (one doctor worked in OPD 5 and OPD 6). The E-7 scorer is unchanged: a match means ≥ 50% overlap of the shorter interval.
- **Signals (no raw audio, since the box has no R2 read access yet).**
  - Energy: `bench_level_sample` peak every ~2.3 s, in 10-s bins. A bin is active above 1.5 × the room's 20th-percentile peak (its quiet floor).
  - Speaker turnover: from the diarizer's own segments (`diarize_window_label`, pyannote.ai/local, audio-only). These cover 80 of 142 windows.
  - Queue: PQM `called_at` / `completed_at`.
- **Parameters.** All declared in `study.py` before the first score. The grid below is reported, not used to choose.

## Result (23 Sep, 16 consults)
| Arm | Clips | Recall | Precision | Splits | Start err (median min) | End err (median min) |
|---|---|---|---|---|---|---|
| E-shadow acoustic (today, stored) | 13 | 3/16 | 4/13 | 1 | 2.9 | 5.5 |
| E-6 fusion (today, stored) | 7 | 3/16 | 3/7 | 0 | 2.9 | 5.5 |
| **a** acoustic only (energy + turnover) | 91 | 14/16 | 17/91 | 3 | 5.0 | 3.0 |
| **d** acoustic, inside the queue's working span | 28 | **14/16** | **17/28** | 3 | 5.0 | 3.0 |
| b queue only (PQM snapped to energy edges) | 16 | 16/16* | 16/16* | 0 | 0.3* | 0.5* |
| c1 fused (PQM anchors moved to energy edges) | 14 | 14/16* | 14/14* | 0 | 0.9* | 1.0* |
| c2 fused + unqueued acoustic segments | 87 | 14/16* | 14/87* | 0 | 0.9* | 1.0* |

\* **Circular.** E-7's truth IS PQM, so any arm that uses PQM consult times scores well by construction. Arms **a** and
**d** are the real tests. In arm d the queue supplies only the day's first call and last completion (±10 min), never
a per-consult time.

**Why today's clock fails and this doesn't.** E-shadow and E-6 need stored transcripts. 7 of the 16 consults were called between
12:10 and 14:15, around the 12:50 STT outage; several others are thinly transcribed; 3 were called after 15:45. The level
log runs all day, so energy sees all of them.

**Robust, not tuned.** Across all 9 grid settings (K = 1.3/1.5/2.0 × merge gap 30/60/120 s), arm a finds **13–16 of 16**,
at 15–20 matches out of 57–94 clips. The recall doesn't come from one lucky setting.

**Where arm a's precision goes.** 65 of its 91 clips are talk outside the doctor's working span (before the first call, after the
last completion). The queue span removes them (arm d). Inside the span, the remaining errors are 3 splits (a consult cut in two) and
consult-shaped talk the queue doesn't hold.

## What the queue says about the audio
- Cardiology and OPD 5: talk fills 87–94% of every queued consult, and only 1–2 min of talk lie outside a consult within the span.
  Here queue and audio agree.
- OPD 3: 2 of 11 queued consults show NO talk at all (active share 0.00, the two c1 drops), and 77 min of talk lie outside any
  queued consult within the span. Either the queue doesn't match what happened in the room, or the room had
  other conversations. Cutting on the queue alone would be wrong here; cutting on audio isn't.

## Joins (sizing Part A)
- **Today:** one join per 15-min window, **372–393 joins a day** (21–23 Sep, 9–10 recorded room-days).
- **Consult-first, arm d:** ~9 clips per room-day, so **~85–95 joins a day** for 9–10 room-days. That's roughly 4× fewer, and each join is longer (a whole consult; median consult 14.5 min).
- **Arm a without the span:** ~30 clips per room-day, **~270–300 a day**.
- **Hospital-wide:** PQM had 202 consult steps on 23 Sep across 36 doctors. Only recorded rooms need clips.
- **Plus the safety net:** the 5-min live windows stay until consult-first proves itself for a week.

## Limits (read before acting)
- One day, 3 rooms, 16 consults. Boundary errors of 3–5 min are coarse for cutting (pad each clip ±2–3 min).
- Speaker change is thin: only the diarizer's own segments, inside 15-min windows, covering 80/142 windows.
  The planned signal (box diarize twin `/embed_speakers` every ~1.5 s) needs chunk audio. **Read-only R2 access on the box was
  requested (bus #142)** and isn't in place yet. That signal targets the 3 splits and back-to-back consults.
- The energy threshold is per room (the quiet floor) because mic gain differs a lot. OPD 5's mic is quiet: a fixed 0.05 marks 1% of its consult samples active.

## Recommendation
1. **Adopt the shape "queue span + energy cuts" (arm d) as the consult-first segmenter candidate.** It already beats the
   encounter clock on recall (14/16 vs 3/16) and on precision (61% vs 43%), without STT.
2. **Validate out of sample on 24 Sep,** the first full day with level data from clinic start, with the SAME declared
   parameters. It can ride tonight's 21:00 rescore if Fable wants (a few lines in `score_arms.py`).
3. **Add speaker embeddings when R2 read access lands,** to split back-to-back consults and tighten boundaries.
4. Pipeline change (per the order: design after the report): day tape → arm-d segments (±2 min pad) → one sharded join per
   segment → STT + diarization per consult, with the 5-min windows as the live safety net.

Files: `study.py` (declared parameters, all arms, the grid, diagnostics). Outputs in `~/eta-data/encounter-first/out`
(times only). No audio or text anywhere; room labels and times only.

## Addendum (24 Sep midday): arm d is now in the E-7 rescore, and the confirmed room set moved
- Arm d runs inside `e7-rescore.sh` for the 21:00 out-of-sample check on 24 Sep (Fable, 10:20). It uses `segmenter.py`, the
  single implementation that `study.py` now imports. The refactor was a no-op: all 16 hypothesis files are byte-identical and
  every score is unchanged.
- **The voiceprint-confirmed set drifts as diarization fills in.** Re-run now, 23 Sep confirms Cardiology, OPD 3 and **OPD 6**,
  but no longer **OPD 5**. Overnight processing multiplied OPD 5's attributed turns (350 → 2915), and its top clinician's share
  fell to 0.73 (the bar is 0.8). With the doctor now in OPD 6, the truth is 17 consults.
- On that different room set, through the rescore, **arm d: recall 13/17, precision 16/31**. The E-6 arms from last night's replay:
  2/17. Arm d's lead holds across room sets.
- For tonight's 24 Sep score: which rooms are confirmed depends on how much of the day is diarized by 21:00. The rescore log
  prints each room's turns, attributed count and share, so read the scores next to them.

## Boundary case P02 (surgery v2 pilot; V's note, Fable action "log the P02 boundary case for arm d")
- **What V found:** P02 is a PQM consult in OPD 3 on 23 Sep, called 09:12:55, completed 09:28:06 (15.2 min). Per V, the
  first part is a private staff–doctor conversation and the second part is the consult. So the PQM interval, which is
  E-7's truth, includes non-consult talk.
- **What arm d did:** two clips.
  - 09:11:10–09:18:30.
  - A 70-s quiet gap starting 09:18:35; the diarizer's only speaker-turnover point inside P02 is at 09:20:15.
  - 09:19:40–09:26:20, the clip that matches P02 in the score.
  So arm d cut about where V places the switch from staff talk to consult. Only the second clip is the consult.
- **What E-7 recorded:** a SPLIT (one PQM consult, two clips), which counts against arm d. It is probably a correct cut
  that a PQM-based truth penalises.
- **Consequences:**
  1. PQM start times carry non-consult talk, which inflates the start errors of every arm.
  2. Arm d's 3 splits on 23 Sep need a human look before being read as errors.
  3. The embeddings arm, speaker change every ~1.5 s, is exactly what separates staff–doctor talk from doctor–patient
     talk. P02 is its first labelled test case once R2 access lands.
- The exact switch second is not labelled (V's note is qualitative), so this is evidence, not a score.

## Embeddings arm (arm e), run once R2 read access landed (24 Sep afternoon)
**Method.** ECAPA (`speechbrain/spkrec-ecapa-voxceleb`, the box diarize twin's own cached weights) on every energy-active
1.5-s window of the 3 room-days. That is 29,741 windows, batched on CPU at nice 10 (`embed_local.py`), not through the
twin's service, which serves the daytime bulk pool. The windows were clustered across the whole day (declared: join at
cosine ≥ 0.55, a speaker needs ≥ 20 windows), and the clusters were fed to the SAME turnover rule inside arm d
(`arm_e.py`). Audio came read-only from R2 (`r2audio.py`) and stays in ~/eta-data.

| Arm | Recall | Precision | Splits | Start err median | End err median |
|---|---|---|---|---|---|
| d (diarizer-label turnover) | 14/16 | 17/28 (61%) | 3 | 5.0 min | 3.0 min |
| **e (embedding turnover)**, declared 0.55 | 14/16 | 20/32 (62.5%) | 5 | 2.0 min | 4.0 min |
| e, grid 0.45 (not chosen) | 14/16 | 63.3% | 5 | 3.8 min | 4.0 min |
| e, grid 0.65 (not chosen) | 14/16 | 64.5% | 6 | 2.0 min | 2.1 min |

**Reading.** On 23 Sep the embeddings do NOT materially improve on arm d. Recall and precision are flat across the grid,
the median boundary errors move within 2–4 min, and there are 5–6 splits instead of 3. Over half of all 1.5-s windows are
noise at every threshold: a 1.5-s ECAPA window is a weak identity signal.
**What they do give: independent confirmation of a cut.** At P02 the embeddings put a voice turnover at **09:18:15**,
at arm d's staff→consult cut (the 70-s silence from 09:18:35), which supports V's reading. Some of the extra splits may
be correct cuts of the same kind, which PQM truth cannot tell apart.
**Recommendation (unchanged, strengthened).** Keep arm d as the consult-first segmenter candidate. Use embeddings as a
boundary CHECK, not a cutter: flag clips where a voice turnover falls near a cut. Revisit with longer windows (3 s), or
with the hybrid diarizer's cross-window speaker ids, before giving them cutting power.
