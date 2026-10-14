# VAD-trim backchannel bench (rulings 11 + 29) — lab-mover, 24 Sep 2026

**Question:** what would a safe `DIARIZE_VAD_TRIM` setting be, and what happens to short backchannels ("haan", "achha", "hmm")?
`DIARIZE_VAD_TRIM` stays OFF. Nothing here was sent to the Mini; every call went to the box twin's `/speech_regions` (same code as the Mini's).

## Plain-language result
1. **Silero on its own is not safe.** If the trim used Silero's verdict alone, it would remove 26.5% of labelled speech (collared), 22 of 31 long-enough windows would lose more than 2%, and 65 of 92 *isolated* short backchannels would be deleted outright. Turning the knobs (threshold, padding, min-silence, min-speech, extra post-padding) only moves that from 20% to 32%. **No Silero setting tested is safe on its own.**
2. **The app's level-log guard is what makes trimming safe, and it makes the Silero settings almost irrelevant.** With the guard (cut only where the level log observed a quiet 15 s bucket, peak < 0.00398, AND Silero also says silence), all 13 settings lose 0.00% of labelled speech (0.44 s of 9,867 s at most, 0.0 s collared), drop 0 segments ≥ 0.3 s, and drop **0 of 1,984** short (<0.5 s) backchannels, including 0 of 92 isolated ones.
3. **The catch: the guard rarely engages.** Only 6 of the 40 windows contain any quiet bucket at all. Total saving is **6.9% of audio** (2,486 s of 35,998 s) at production defaults, 4.6–7.6% across settings. That is the whole benefit on this data.
4. Independent check that the zero is real and not a Silero effect: only **4.9 s** of labelled speech (of 9,867 s) lies inside level-log-quiet buckets at all, so even the guard alone would cut almost nothing of speech; Silero's veto removes most of those 4.9 s.

**Recommendation.** If the trim is ever turned on: keep the level-log guard mandatory (never trim on Silero alone; the app's rule that an empty VAD answer keeps the whole clip stays), and keep production defaults (S0) — no other setting improves the guarded result (loss is already 0), and the protective settings (S11/S12) only cost savings (5.5%/4.6%). Expected gain: ~7% less audio sent to diarize; not compelling next to the risk of any regression in the guard. Ruling stands: **OFF**; nothing on this data justifies turning it on for speed alone.

## Method
- **Windows:** 40 of the 58 labelled 900 s windows that have ≥ 150 level-log samples (level rows read-only from Neon), 10 sessions, 36,000 s of audio, 9,867 s of pyannote.ai-labelled speech, 6,625 teacher segments, 1,984 shorter than 0.5 s, 92 of those isolated (≥ 1.0 s of teacher silence each side).
- **Audio:** the WAVs re-encoded to webm/opus like production; all 40 verified to full duration (two truncated files from an interrupted first encode were caught by the duration check and redone before the run).
- **Endpoint:** `POST /speech_regions` on the box twin, `allow_cut` = whole clip, Silero params per setting (base: threshold 0.15, min_silence 1200 ms, speech_pad 500 ms, min_speech 250 ms, pad_s 0).
- **Policy P_all:** what Silero alone would cut. **Policy P_real:** cuttable = level-log quiet buckets (offline port of the app's `observedQuietSpans`: 15 s buckets, observed, max peak < 0.00398) minus Silero speech; a VAD-empty answer keeps the whole clip. P_real is derived offline from the endpoint's answer using the endpoint's own definition (cuttable = allow_cut minus VAD speech), not sent as a separate call.
- **Metrics:** labelled-speech loss (raw, and ±0.25 s collared per the VAD-V3 rules), windows over 2% (≥60 s-speech regime, 31 windows), whole segments dropped (≥ 0.3 s and ≥ 80% cut), backchannel = teacher segment < 0.5 s, "dropped" = < 50% of it kept, "zero" = none kept, audio saved.

## Table (aggregate over 40 windows; loss = collared)
| setting | P_all loss | P_all windows >2% | P_all isolated short dropped | P_all saved | P_real loss | P_real short dropped | P_real saved |
|---|---|---|---|---|---|---|---|
| S0 production defaults | 26.53% | 22 | 65/92 | 73.5% | 0.00% | 0/1984 | 6.9% |
| S1 threshold 0.10 | 25.24% | 22 | 63/92 | 72.3% | 0.00% | 0/1984 | 6.6% |
| S2 threshold 0.30 | 31.75% | 22 | 71/92 | 77.8% | 0.00% | 0/1984 | 7.6% |
| S3 min_silence 600 | 26.66% | 22 | 66/92 | 73.6% | 0.00% | 0/1984 | 6.9% |
| S4 min_silence 2500 | 25.87% | 22 | 65/92 | 72.8% | 0.00% | 0/1984 | 6.9% |
| S5 speech_pad 300 | 27.29% | 22 | 66/92 | 74.5% | 0.00% | 0/1984 | 7.1% |
| S6 speech_pad 1000 | 24.94% | 22 | 63/92 | 71.1% | 0.00% | 0/1984 | 6.5% |
| S7 min_speech 30 | 26.44% | 22 | 65/92 | 73.3% | 0.00% | 0/1984 | 6.9% |
| S8 min_speech 100 | 26.44% | 22 | 65/92 | 73.3% | 0.00% | 0/1984 | 6.9% |
| S9 post pad_s 0.5 | 24.94% | 22 | 63/92 | 71.1% | 0.00% | 0/1984 | 6.5% |
| S10 post pad_s 1.0 | 23.77% | 22 | 61/92 | 69.1% | 0.00% | 0/1984 | 6.1% |
| S11 protective combo | 22.06% | 22 | 58/92 | 66.4% | 0.00% | 0/1984 | 5.5% |
| S12 very protective | 20.20% | 22 | 54/92 | 62.4% | 0.00% | 0/1984 | 4.6% |

P_all at S0 also drops 1,444 whole segments ≥ 0.3 s and 620 of the 1,984 short segments (604 with nothing kept). Full per-window numbers: `vad_trim_bench_results.json`. Script: `vad_trim_bench.py`, log `vad_trim_bench.log`.

## Limits — read before relying on this
- **Teacher labels are pyannote.ai output, not human truth.** Some "backchannels" may be label noise; "kept" means the audio span survives, not that a transcript would be right.
- **Only 6 of 40 windows had quiet buckets.** The zero-loss result is on a small, quiet-rare sample; it says the guard is conservative, not that it is proven safe on all rooms. A room with a low-gain mic and a low level floor could differ. The 18 labelled windows without ≥150 level samples were not covered (the guard would not fire there: no level data means no cut).
- **P_real is an offline reconstruction** of the guard (level rows from Neon, bucket rule ported from the app). It was not run through the app's real code path or the Mini; a Refuter pass on the port (bucket boundaries, `samples` handling) is needed before the Mini gets `/speech_regions` (ruling 20).
- The 4.9 s of labelled speech inside quiet buckets shows the level floor itself is not perfectly speech-free; Silero's veto is doing that last bit of work.
- Level-log timing alignment to window start was taken from the same `t_ms` convention as the app; one bucket off would change savings, not the sign of the conclusion.
