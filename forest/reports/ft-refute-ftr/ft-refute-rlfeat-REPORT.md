# ft-refute-rlfeat REPORT (Opus 5.5 refuter, global.anthropic.claude-opus-5-5), 20 Oct 2026 ~03:20 IST
Target: ~/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet (369 x 168). I recomputed everything from the STT json (933), manifest.tsv, labels.parquet (v2) and rl/feat/{tags,texts,calls_basic}. No vendor calls. I read lane code only AFTER writing work/OWN-NUMBERS.txt, and only to explain discrepancies.
VERDICT: PASS-WITH-FIXES. The headline counts reproduce exactly. One landmark-design fix is needed downstream (F1).

## (1) Split: PASS
- split_guard loaded with list pin 52959278... and the seed sha set to 3b10cbf1...: lock RD0-2026-10-18-52959278edd8, 2744 keys, seed verified.
- H rows = 0 everywhere: parquet 369/369 D (labels split, and cluster_key via the guard); manifest patient_key, all 1407 rows D (933 shard rows D); STT json episodes 369 D; calls_basic D.
- STT files 933 = shard keys 933, 0 extra. 474 unsharded manifest rows are not transcribed (G1 OK).

## (2) Windows: PASS (counts), FIX needed (F1)
- day_from_rx = call_date - rx_date for 933/933 calls; range 0..13 (G2 OK). The 207 day-0 calls are all after_consult=1, and 0 have call_ts before the consult time.
- Calls on/after event_date: 0. Tagged 922, untagged 11 (excluded). outcome_revealed (last tag) 140, dropped.
- My counts, all identical to the claim and to the parquet n_calls_tT for every episode (0 mismatches):
  - T=3: 255 eps / 445 calls; h14 38/220; h90 33/112
  - T=7: 306 / 632; h14 41/269; h90 36/133
  - T=14: 344 / 782; h14 42/303; h90 38/156
- F1 (top issue): rows are kept for episodes whose event happened BEFORE the landmark. Among h14 positives, the event day is < T for 11/38 (T=3), 24/41 (T=7) and 41/42 (T=14). Those windows are cut short by the surgery: mean n_calls for pre-event positives is 2.14, vs 4.06 for at-risk positives and 1.93 for negatives (T=7).
  - So call volume, minutes and tags partly encode "already operated". The parquet has no days_to_surgery or at-risk flag.
  - Fix: downstream landmark models must keep only days_to_surgery >= T (or NaN). At-risk sets: T=3 244 eps, h14 27/209, h90 26/105; T=7 278 eps, h14 17/245, h90 21/118; T=14 297 eps, h14 1/262, h90 12/130.
  - The h14 signal at T=7 is then 17 positives: DIRECTIONAL at most. An at_risk_tT column should be added, or COVERAGE should state this.
- F2 (minor): tags.jsonl has 1197 lines for 922 calls (247 re-tagged). The last line is used. For 9 calls the outcome_revealed flag differs across reruns; with "any run" the counts would be 443/630/779 calls, episode counts unchanged.

## Quotes: PASS-WITH-NOTE
- Last tag per call: 2374 quotes, 2368 exact substrings of texts.jsonl. 6 are not exact; all 6 are case-only differences, which the ftc_tag verifier accepts via lower().
  - 4 of the 6 back features on kept calls (1 intent, 1 next_step, 2 insurance objections).
  - Across all 1197 lines: 7/3075 not exact. Fields without a backing quote: 0. Offsets mismatch only for those same 6.
- The claim "exact quotes" should read "exact up to case".

## (3) Talk-time, 50 random calls (seed 20261020) vs calls_basic: PASS
- n_speakers, n_segs, speech_s and words_total: 50/50 exact. call_span_s: 49/50.
- Speaker seconds {largest, rest} = {counsellor_s, patient_s}: 40/50. The other 10 calls have 3 or more diarized speakers, which the lane maps to 2 roles. That is 250/933 calls with 3+ speakers overall.
- turns_per_min: 43/50 match "speaker changes / span-min". The other 7 differ by 0.5-1.3/min because of the lane's same-role merge with gap <= 1.5 s. That is by design; definitional, not a bug.
- Episode aggregates: speech_min_tT and patient_talk_share_tT (mean over calls) match 100% at T=3/7/14.
  - minutes_tT = sum of diarized call_span_s, NOT audio duration (it matches audio duration for only 64/306 at T=7). Document the name.

## (4) Roles: PASS-WITH-NOTE
- role_src: talk_fallback 678 (72.7%), lexicon 254, single_speaker 1. Fallback accuracy proxy: on lexicon calls, the lexicon counsellor also has more words in 220/254 (87%). So the fallback is not pure noise.
- But 37% of fallback calls are near-ties (word gap < 20%), where role assignment is close to a coin flip.
- Patient Odyssey windows from fallback calls: 2856/3942 (72%). At T=7, 174/306 episodes are 100% fallback; the median episode's patient windows are 100% fallback.
- role_fallback_share_tT reproduces (0.654/0.690/0.704).
- Patient-side features (patient_valence_*, patient_arousal_*, patient_talk_share, patient_wpm, valence_gap, mean_patient_turn_s, patient_interrupt) are mostly fallback-based. Prefer the mixed_* / speech_min / wpm_all features, or gate on role_fallback_share.

## (5) Leakage of text/PHI: PASS
- Parquet object columns: episode_id (16-hex), intent_last_tT (4 enum values), split. Transcript 6-gram hits in parquet bytes: 0. Arrow/pandas metadata is schema only.
- COVERAGE.md and DONE.md: 0 digit runs of 7 or more, 0 phone-like strings, 0 hex ids, 0 transcript 5-gram hits.
- Perms: parquet and COVERAGE 0600; rl/feat and rl/stt 0700. DONE.md is 0664 (counts only; tighten to 0600 for consistency).

Files: work/OWN-NUMBERS.txt, work/*.py, work/S.parquet, work/talk50.parquet (all 0600/0700, refuter dir only).
