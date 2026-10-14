# Nemotron-3-Diarization bake-off (order DIAR-NEMOTRON-BAKEOFF, 24 Sep 2026)

Model `nvidia/Nemotron-3-Diarization` (100M Sortformer, OpenMDW 1.1, not gated), NeMo `NVIDIA-NeMo/Speech@cf724ac` (PyPI nemo-toolkit 3.0.0 does NOT load it: no RoPE encoder; main does),
offline 30.4 s setting (spkcache 264, fifo 40, chunk 340, right-ctx 40, update 300). Local GPU only, no audio uploaded. Harness = phase-1 harness (pyannote.metrics, collar 0.25, overlap scored).
DER is against pyannote.ai (a strong reference, not ground truth). V's 5 speaker counts are the only human truth. `bw_9j4z2ze3_1789989300000` (all arms DER 12-26, phase-1 outlier) is excluded from bench means; per-arm value in `nemotron_results.json`.

## Table (V's 5, and the 20-window bench minus that outlier = 19)
| arm | V5 mean DER (miss/FA/conf) | V5 count err vs V | bench median DER | bench mean DER (miss/FA/conf) | bench count err vs pyannote.ai |
|---|---|---|---|---|---|
| Nemotron-3 | 0.414 (.056/.269/.089) | 0.4 | 0.150 | 0.230 (.062/.106/.062) | 1.47 |
| pyannote.ai (teacher) | reference | 0.0 | reference | reference | reference |
| local stock 3.1 | 0.530 (.131/.256/.144) | 1.2 | 0.225 | 0.328 (.064/.146/.118) | 2.63 |
| local fine-tuned (04:00 run) | 0.357 (.192/.048/.117) | 1.2 | 0.179 | 0.245 (.123/.034/.088) | 2.26 |

V5 per-window DER (Nemotron / stock / fine-tuned): yce79u6r 0.071/0.173/0.102; d4t5tvg9 0.469/0.659/0.499; maaacrdh 1.097/1.324/0.871; zyjykmwa 0.140/0.213/0.147; m6nq7upz 0.295/0.283/0.167.
Nemotron's V5 error is mostly false alarm (it marks more speech than pyannote.ai, consistent with overlap-aware far-field training); maaacrdh is bad for every arm.

## Speed (wall time, model already loaded, first window excluded as warm-up)
L4: 8.4 s per audio-hour (7.4 on V5). T4 (box): 26 s per audio-hour. Local pyannote 3.1 on the same L4: about 130-200 s per audio-hour, so Nemotron is ~15-25x faster.

## T4
Runs. The box driver is 550 (CUDA 12.4), so it needs torch cu126 (2.14.0+cu126); the L4 build uses cu130. Output matches the L4 run: same speaker counts on all 25 windows, DER between the two runs mean 0.003 (max 0.06).

## Hybrid (Nemotron turns -> ECAPA /embed_speakers on the box twin -> attribution)
`voice_centroid` is still EMPTY, so real doctor attribution cannot be tested. Proxy (`hybrid_proxy.py`): pyannote.ai's speakers in each window are the "enrolled identities"; each arm speaker (>= 5 s speech) is attributed by greedy one-to-one cosine on the longest-span ECAPA embedding (the production rule) and compared with the identity implied by time overlap.
Time-weighted agreement / speaker agreement: Nemotron 0.913 / 0.744 (67 of 90); fine-tuned 0.902 / 0.587; stock 0.852 / 0.526. Nemotron turns work in the hybrid at least as well as pyannote-family turns; this is a consistency proxy, not a doctor-ID accuracy.

## Where Nemotron and pyannote.ai disagree most (for V to listen; window ids only)
1. bw_d5aype5r_1790052300000_primary (DER 0.73)
2. bw_jk5s2tfs_1790045100000_primary (DER 0.66)
3. bw_wwq9p6eb_1789803000000_primary (DER 0.46)
Also flag bw_9j4z2ze3_1789989300000_primary (DER 15.3, every arm disagrees with the teacher there; likely a teacher/audio mismatch).

## Recommendation
KEEP pyannote.ai for now; adopt Nemotron-3 as the local fallback / shadow engine (replaces stock 3.1), and REDIRECT the local-training programme to fine-tuning Nemotron on the teacher labels.
Why: Nemotron is the best local arm on every measure (bench median 0.15 vs 0.23 stock and 0.18 fine-tuned, count error vs V 0.4 vs 1.2, 15-25x faster, runs on T4 and L4) and it needs no training to get there. It does NOT yet match pyannote.ai: ~15 DER points median from the teacher, and pyannote.ai still has the perfect V5 count (0.0 vs 0.4). To stop paying pyannote.ai, first (a) have V listen to the 3 windows above to see who is right, (b) shadow-run Nemotron beside pyannote.ai in production for a few days (DIARIZE_ENGINE unchanged) and (c) enrol doctor voiceprints so the hybrid can be tested for real.

## CAVEAT (added after the refuter verdict, REFUTER-2-VERDICT.md, T1)
The permanent test set was excluded from training by window id, but training splits are by room-day, and the 20 test windows sit on 15 room-days. In the merged dataset `diar-train-merged-2026-09-24-657c0c9e`, 19 of 173 windows (16 train, 3 test-split; 5 room-days) share a room-day with a test window. So the **local fine-tuned pyannote-3.1 arm in this table is not clean evidence**: its test scores can be inflated by having seen the same rooms, mics and doctors. The base Nemotron-3 arm and stock 3.1 were never trained on our data and are unaffected. Fix under way: exclude all 15 test room-days from train and val, then retrain and re-score.

## First Nemotron fine-tune (run-2026-09-24-035539-nemotron-657c0c9e) — LEAKY, not clean evidence
Ruling 44 start: 500 steps, lr 1e-5, batch 8, seed 42, dataset `diar-train-merged-2026-09-24-657c0c9e` (161 train windows, 5-window held-out room-day rd_yhh6kexm; 4 windows skipped for >8 teacher speakers), best checkpoint by val F1 (0.912). Scores: `ft-run-…_scores.txt`. **Contaminated by refuter T1**: 16 of the 161 train windows share a room-day with a permanent-test window (and T2, 16 possibly gap-shifted WAVs, is not yet applied). Treat as an upper bound until the clean re-run.
| arm | V5 mean DER | V5 count err vs V | bench median DER | bench mean DER | bench count err vs pya | outlier window DER |
|---|---|---|---|---|---|---|
| Nemotron-3 base | 0.414 | 0.4 | 0.150 | 0.230 | 1.47 | 15.3 |
| Nemotron-3 fine-tuned (leaky) | 0.312 | **1.4** | 0.102 | 0.188 | 1.47 | 1.8 |
| pyannote.ai (teacher) | reference | 0.0 | reference | reference | reference | reference |
Read: DER against the teacher drops (median 0.150 → 0.102) but the speaker-count error against V's human counts gets WORSE (0.4 → 1.4), while the teacher's is 0.0. Fitting the teacher's segmentation is not the same as getting the right number of people; the clean re-run should be judged on both, and on V5 counts in particular.

## Clean run 2 (ruling 45) — target NOT met; nothing beat the untuned base on speaker count
Run `run-2026-09-24-051739-nemotron-13537f4e`: clean manifest `diar-train-clean-2026-09-24-13537f4e` (refuter split check PASS: 15 test room-days excluded, train 116 windows / 9 room-days after 4 windows with >8 teacher speakers were skipped, val 34 windows / 3 room-days), lr 1e-5, batch 8, seed 42, count scored every 50 steps, stop on count. It stopped at step 200 (4 checks with no val-count improvement).
| step | val count MAE vs teacher (34 val windows) | val bias | V5 count MAE vs V (logged, not used to select) | V5 counts (V: 4,7,5,3,4 in window order yce/d4t/maa/zyj/m6n) |
|---|---|---|---|---|
| 0 (untuned base) | 0.765 | +0.35 | 0.4 | 5,7,4,3,4 |
| 50 | 0.765 | -0.59 | 1.4 | 5,5,2,3,3 |
| 100 | 0.765 | -0.65 | 1.4 | 5,5,2,3,3 |
| 150 | 0.824 | -0.71 | 1.2 | 4,5,2,3,3 |
| 200 | 0.824 | -0.71 | 1.2 | 4,5,2,3,3 |
- **Best-by-count checkpoint = step 0, i.e. the untuned base model.** The "fine-tuned" arm scored in `ft-run-…051739…_scores.txt` is therefore byte-for-byte the base Nemotron's numbers (V5 DER 0.414, count 0.4; bench median 0.150); it is NOT a fine-tune and must not be read as one.
- **What happens:** within 50 steps the model flips from a slight over-count (+0.35) to a consistent under-count (-0.6 to -0.7): it merges speakers (V5 window maaacrdh 4 -> 2 speakers, d4t5tvg9 7 -> 5) while the segmentation loss keeps improving (val_loss 0.072). Fitting the teacher's turns at this learning rate trades away the number of people.
- **Speaker-count target (<= 0.2 on V's 5) not met.** The untuned base is at 0.4 (2 of 5 windows off by one); no fine-tuned checkpoint got closer.
- Reading: pyannote.ai stays primary on counts (0.0 on V5). Follow-ups being probed on the same clean split: lower lr (2e-6) and longer training crops (300 s vs the default 105 s), since short crops see few speakers per sample and may teach the model to under-count.

## Count-drift probes (clean split, same manifest, same seed; records `runs/run-2026-09-24-053809-…` (p1), `…061249…` (p2b), `…060903…` (p2, FAILED: CUDA OOM at batch 4 x 300 s))
Full count curves, never early-stopped, count every 25 steps. Val = 34 windows / 3 held-out room-days (count error vs teacher); V5 = human counts, logged only.
| step | p1: lr 2e-6, 105 s crops, batch 8 — val MAE / bias / V5 MAE | p2b: lr 2e-6, 300 s crops, batch 2 — val MAE / bias / V5 MAE |
|---|---|---|
| 0 (base) | 0.765 / +0.35 / 0.4 | 0.765 / +0.35 / 0.4 |
| 25 | **0.559** / +0.21 / 0.4 | **0.618** / +0.21 / 0.4 |
| 50 | 0.588 / -0.35 / 1.2 | 0.647 / 0.00 / 1.0 |
| 100 | 0.706 / -0.53 / 1.0 | 0.676 / -0.38 / 1.0 |
| 200 | 0.706 / -0.59 / 1.0 | 0.735 / -0.56 / 1.0 |
| 300 | 0.794 / -0.68 / 1.0 | 0.765 / -0.65 / 1.0 |
- **Crop length is not the cause.** 300 s crops slow the drift a little (bias 0.0 at step 50 vs -0.35) but reach the same under-count (-0.65) by step 300. V5 window maaacrdh (V: 5 speakers) collapses to 2-3 in both, as in run 2. A lower lr (2e-6 vs 1e-5) delays but does not remove it. The under-count is a property of fitting these teacher labels, not of the crop setting.
- **A light touch helps a little.** Best-by-count in both probes is step 25 (about 200 crops). p1 step 25 evaluated on V5 + bench20 (`probe-p1-step25_*.json`): V5 DER 0.414 -> 0.342, V5 count error vs V 0.4 (unchanged), bench median DER 0.150 -> 0.144, bench mean excl. outlier 0.230 -> 0.210, bench count error vs pyannote.ai 1.47 -> 1.26. Clean split, so this is a real but small gain; the count target (<= 0.2 on V5) is still not met, and val count error only improves 0.765 -> 0.559.
- **Not tried yet (would need trainer changes, so refuter review):** freeze the encoder and train only the Sortformer head; reweight or oversample windows with >= 4 speakers; add a count-aware auxiliary term. The 4 windows with > 8 teacher speakers are skipped, which removes the highest-count examples.
