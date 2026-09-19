# ETA — why the room voice matcher has never matched anyone. ROOT CAUSE, 19 Sep 2026

**Answer in one sentence: the matcher was never asked about anybody it can identify.** It is not
miscalibrated, not mis-wired, and 0.65 is not the wrong number — the path has simply never been run on
audio containing a well-enrolled clinician.

## The contradiction that started it

| | cosine |
|---|---|
| Hand-mined Salanki centroid vs his stored voiceprint (18 Sep) | **0.930** |
| Best score ever recorded by the production room path (2,225 rows) | **0.556** |

Same diarize service, same stored voiceprints, same cosine arithmetic. That gap is too large to be noise.

## The decisive experiment

Eight 900 s windows sliced (`ffmpeg -c copy`) from `salanki_18sep.webm` — the day that hand-mined to
0.910 — POSTed to the service with **the exact `loadClinicianCentroids()` payload and
`batch_threshold=0.65` production sends**. Clips 3.40–3.65 MB, inside production's own 3.27–3.99 MB range.

| window | speakers | service returned `clinician_id` | best cosine vs stored print | speaker sec | longest seg |
|---|---|---|---|---|---|
| 0 | 1 | no | 0.028 | 137 | 12.7 |
| 1 | 3 | no | 0.598 | 58 | 4.5 |
| 2 | 4 | **YES** | **0.908** | 387 | 20.4 |
| 3 | 4 | **YES** | **0.853** | 526 | 15.0 |
| 4 | 2 | **YES** | **0.897** | 427 | 12.3 |
| 5 | 4 | **YES** | **0.795** | 208 | 9.4 |
| 6 | 2 | **YES** | **0.780** | 62 | 5.6 |
| 7 | 1 | no | 0.062 | 23 | 8.0 |

**5 of 8 matched, 0.780–0.908, reported by the service itself, with no false positive against 7 centroids.**
Nothing is wrong with the comparison, the payload, or the app.

## Hypotheses, ruled

| # | hypothesis | verdict | evidence |
|---|---|---|---|
| H1 | Too little speech per speaker in a 15-min window | **RULED OUT** as the cause | W6 matched at 0.780 off a **5.6 s** longest segment. Production longest-seg (median 9.2 s, p75 15.1) sits in the same range as the mined days (12.1–21.4 s). Real but second-order. |
| H2 | One human split across several `speaker_idx` | **REAL, SECONDARY** | W2: `idx0 = 0.908` (387 s) and `idx2 = 0.628` (55 s) — one person, two indices, the fragment landing under threshold. **This is what manufactures high-scoring losers.** |
| H3 | Centroid payload mangled in transit | **RULED OUT** | `identical_b64 = True` for all 7. 768 B = 192 × float32 LE, un-normalised, L2 220.96–278.49. No truncation, no endianness or normalisation asymmetry. |
| H4 | Service treats `batch_threshold` calls differently | **RULED OUT** | One `_diarize_blocking`; `batch_threshold` used in exactly one place. |
| H5 | App dropping a real winner before the INSERT | **RULED OUT** | `speakers_json` containing a `clinician_id`: **0 of 153** speakers across 53 windows. There was never a winner to drop. |

## Apportionment

- **Dominant, ~all of it: the path has never run on a room with a room-native enrolled speaker.** Only 53
  diarized windows exist system-wide, across 5 rooms, none of them Salanki's. **OPD 5 — Dr. Salanki has 256
  `bench_window` rows, 1 clip, 0 diarized windows and 0 turn cues.**
- **Secondary: enrolment channel.** The seven prints split into a **13 Sep 01:16 batch** (Salanki and four
  others, enrolled six seconds apart, room-native) and a **May/June cohort**. Vinay speaks 592 s in his own
  Home Office with a 31.4 s segment and still reaches only **0.535** against his own May print — which caps
  the 27 Home Office windows, half the diarized corpus.

**The 0.930-vs-0.556 comparison was never like-for-like: Salanki's audio was never in production, and
Vinay's was never mined.**

## Not determined

- Whether Majumdar / Ankit / Animesh were actually in the rooms where they scored 0.638 / 0.521 / 0.485.
  **`room_day.doctor_id` is NULL for every diarized day** — there is no attendance ground truth at all.
- Why OPD 5 produced 1 clip from 256 windows. Measured, not traced. **This is S2a's first question.**
- Whether Vinay's 0.535 is channel mismatch or a different speaker. **UNVERIFIED** — settled by re-enrolling
  him from room audio.

## What it means for the threshold

**0.65 is not wrong and was not asked an impossible question — it was not asked any question.**
Separation in the probe is clean: true speaker **0.780–0.908**; best non-top **0.628** (probably the split
Salanki); every other centroid **≤ 0.327**; windows where he is absent **0.028 / 0.062**. No false positive.

The 2,225 recorded losers are a **negatives-only distribution**. Calibrating on it would be fitting a
threshold to impostors — the one thing guaranteed to produce a number that looks rigorous and means
nothing.

**Order: drain and diarize OPD 5 (S2a), re-enrol the May/June cohort from room audio (S2b), then set the
thresholds on genuine positives (S2c).** The mining method proved on Salanki on 18 Sep is the
re-enrolment tool.

## Fix worth taking separately

`eta-diarize/server.py:169-173` embeds each speaker from **one segment only** (`longest = max(segments,
...)`), discarding the rest of that speaker's speech in the window. Not the cause of this gap, but it
throws away most of the available signal and makes every score noisier than it needs to be.

---

*Probe artefacts on the Mini: `~/scribe-mining/s2/` (`win.log`, `windows.json`); full log at
`~/scribe-mining/s2-rootcause-scratch.md`. No code, config, threshold or service was changed; no jobs
enqueued.*
