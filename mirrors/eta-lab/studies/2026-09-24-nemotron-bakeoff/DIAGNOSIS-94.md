# Ruling 94 diagnosis (no training) — diar-lab, 24 Sep 2026

## (a) Max-speaker ceiling: 8 slots, NOT the cause
- The released model's own config (`Nemotron-3-Diarization.nemo` -> `model_config.yaml`): line 16 `max_num_of_spks: 8`, and `num_spks: 8` at lines 31/50/62/91 (train/val/test ds and `sortformer_modules`); model card: "up to 8 speakers". Output = 8 speaker channels.
- V5's largest count is 7, and the untuned base already outputs 7 on d4t5tvg9 (V: 7). So a 5-speaker window like maaacrdh is countable; the collapse 5 -> 2-3 after fine-tuning is not a slot limit.
- The ceiling does bind on windows with > 8 teacher speakers: 4 kept training windows (9, 9, 11, 17) and 2 of 20 bench windows (teacher 9 and 14), which the model can never match. Those are probably teacher over-segmentation, but that is unverified.
- Count = number of channels that cross onset 0.5 at all (`PostProcessingParams` onset/offset 0.5, `min_duration_on` 0.0, vad_utils.py:67-72): a speaker who talks for a few seconds is in or out depending on a threshold, so the count is a fragile readout.
=> Per ruling 94.3 there is no ceiling below the counts we see, so the hybrid-fallback branch is not triggered by (a).

## (b) Teacher speaker-count distribution: train is low-count; the test is not
Raw distinct teacher speakers per window (clean manifest; train 120 windows, val 34), and the test sets:
| set | n | histogram (count: windows) | mean |
|---|---|---|---|
| train | 120 | 1:14 2:34 3:24 4:18 5:17 6:3 7:6 9:2 11:1 17:1 | 3.48 |
| val | 34 | 1:7 2:10 3:8 4:6 5:2 7:1 | 2.71 |
| V5 (V's counts) | 5 | 3:1 4:2 5:1 7:1 | 4.6 |
| bench20 (teacher) | 20 | 2:3 3:5 4:3 5:1 6:3 7:3 9:1 14:1 | 5.00 |
- Windows with >= 6 speakers: train 13/120 (11%), val 1/34 (3%), bench20 8/20 (40%). The test windows have far more speakers than what we train and select on; the val set (mean 2.7) is the LOWEST-count set of all, so "stop on val count error" tunes toward low counts.
- Counting only speakers with >= 10 s of speech, train mean drops to 2.53 and val to 2.00; but V's human counts include brief speakers (maaacrdh: V 5, teacher raw 5, only 2 of them >= 10 s). So the right count is the raw distinct-people count, and most extra people in the test windows speak briefly.
- Hypothesis supported: train is dominated by 2-3-speaker windows (49% are 2-3), the model's prior moves low, and short-turn speakers fall below the activation threshold. The base model ALREADY under-counts the bench (mean signed error vs teacher -0.32) while over-counting the low-count val (+0.35).

## (c) Teacher's own count error vs V on V5: 0.0
pyannote.ai raw count = V on all 5 windows (4/4, 7/7, 5/5, 3/3, 4/4). The teacher does not cap what a fine-tune toward it can reach, on the only human truth we have (n = 5).

## Extra (no training): a minimum-speech decode rule is not a fix
Base Nemotron, count only speakers with >= T seconds of speech: V5 error 0.40 (T <= 2), 0.20 at T = 3, 0.40 at T >= 5; bench20 error vs teacher 1.47 -> 1.42 (T = 3) and worse beyond, bias -0.32 -> -0.47. T = 3 drops a 2.1 s phantom in yce79u6r but cannot recover the missing 5th person in maaacrdh, and the 0.20 is picked on 5 windows (not valid selection). Not a finding, only shows the miss is a speaker the model never activates.

## 30 candidate windows for a human speaker-count page (ruling 94.5)
`studies/2026-09-24-count-page/candidates.json` (ids, room-days, teacher count only; `training/diar-lab/prep_count_page_candidates.py`): 5 windows per teacher-count stratum 1,2,3,4,5,6+, drawn from labelled windows on room-days NOT in the clean train/val split, V5 and windows seen by the tainted run 1 excluded, spread over 18 room-days (pool 107 windows, thinnest stratum 6+ has 6).

## Consequence for the variants
The count is under-determined by the training mix, not by the architecture. Order stays A (head-only, least forgetting), then B (count-balanced; oversample >= 4-speaker windows, crop the > 8-speaker windows instead of skipping), then C (count-aware loss). Also worth a no-training arm D: lower the onset threshold / add min-duration handling on the stored activity probabilities, tuned on val, scored on V5 + bench. Each trainer diff goes to eta-refuter-2 before launch.

## Ruling 103 follow-up: val re-stratified to the test count distribution
`datasets/diar-train-clean-2026-09-24-b642fdd2.json` (same 154 windows, same 15 excluded test room-days, new room-day split by `make_clean_manifest.py --val-strategy count-match`; refuter split check requested). Val = the room-days whose teacher-count histogram (1..6+) is closest (L1) to bench20's (windows with <= 8 speakers), exhaustive over 2-5 room-day subsets of 20-40 windows; the chosen rule, target, chosen L1 and next-best options are recorded in the manifest (`val_selection`). Val L1 to the test distribution 0.69 -> 0.40; val mean 2.7 -> 3.8 (test mean 4.3 on <= 8-speaker windows, 5.0 with the > 8 ones). This is the best a room-day split of the clean pool can do: none of the 12 clean room-days has a mean above 4.4. Train becomes 112 windows (mean 2.83), even lower-count than before, which is what variant B (oversampling >= 3 / >= 4 speakers) is for.

### Split-check facts for the refuter (#300 items 1-6)
Manifest `datasets/diar-train-clean-2026-09-24-b642fdd2.json` (sha256 b3c62b77abbc1509…, build script `make_clean_manifest.py --val-strategy count-match`, commit 80bcf16). Same 154 windows and the same 15 excluded test room-days as 13537f4e.
1. Test disjointness: 0 windows on any of the 15 permanent-test room-days (`datasets/permanent-test-room-days.json`).
2. Train/val disjoint by room-day: val = rd_4fsw6f6y, rd_7usy23ex, rd_ntajfras, rd_tp4hcf8s; the other 8 room-days are train; whole room-days only, never single windows.
3. Stratification uses TEACHER counts from the train/val pool only (windows with <= 8 speakers), target = the bench20 teacher histogram (a test-set histogram used ONLY as the shape to match, no test audio or test labels used to train or select; the refuter may prefer a target from the pool itself, see the note below).
4. Cost, windows with <= 8 teacher speakers (bucket 6 = 6-8):
| | n | room-days | hist 1/2/3/4/5/6+ | >= 4 speakers | >= 6 speakers |
|---|---|---|---|---|---|
| old train | 116 | 9 | 14/34/24/18/17/9 | 44 | 9 |
| new train | 112 | 8 | 18/38/23/17/13/3 | 33 | 3 |
| old val | 34 | 3 | 7/10/8/6/2/1 | 9 | 1 |
| new val | 38 | 4 | 3/6/9/7/6/7 | 20 | 7 |
  **Train lost most of its high-count windows to val** (>= 6 speakers: 9 -> 3; >= 4: 44 -> 33), so train's mean falls to 2.83 and the data variants A/B see changes too; variant B (oversample >= 3 / >= 4) matters more, and the >8-speaker crops (2 x 9, 11, 17 speakers, all still in train) become the main source of high-count training material. The 4 windows with > 8 teacher speakers sit in train room-days rd_errdkjhe and rd_9q4u73rr.
5. The trainer selects/stops on val count error vs the TEACHER; V5 is logged, never read by selection (`train_nemotron.py` CountEval); the run record carries `excluded_test_room_days`, `val_room_days`, `train_room_days`.
6. New manifest id b642fdd2, build script committed.
Note on the target: the pool has no room-day with a mean above 4.4, so no split of it reaches the bench mean (5.0). Using the bench20 histogram only as the shape to match is a mild use of test information; if the refuter wants, the target can be replaced by the histogram of all teacher-labelled production windows (I can rebuild in minutes).

## Arm D (no training, ruling 103): decode-side thresholds do NOT move the counts
Base Nemotron re-decoded with onset/offset 0.5 or 0.3 and min_duration_on 0 or 0.5 s (`eval/nemo_decode_sweep.py`; the earlier 5-config run on the OLD val with V5 ids taken from bench20 audio was invalid for V5 and is superseded):
| config | NEW val (38) count MAE / bias vs teacher | V5 (real audio) count MAE, counts | bench20 (19) MAE / bias vs teacher |
|---|---|---|---|
| onset .5, md 0 (default) | 0.92 / -0.13 | 0.40 [5,7,4,3,4] | 1.47 / -0.32 |
| onset .3, md 0 | 1.05 / +0.05 | 0.40 [5,7,4,3,4] | 1.47 / -0.32 |
| onset .5, md 0.5 s | 0.97 / -0.18 | 0.40 [5,7,4,3,4] | 1.47 / -0.32 |
| onset .3, md 0.5 s | 0.95 / -0.11 | 0.40 [5,7,4,3,4] | 1.47 / -0.32 |
V5 and bench20 counts are IDENTICAL across all four configs, and the best val setting is the default: the speakers the model misses (maaacrdh's 5th person; the 6-9 speaker bench windows) never rise above even a 0.3 activation. The under-count is inside the model's activity output, not the readout. Arm D is a NO; the fix has to be in the model (variants A/B/C) or in a hybrid count.
Also: on the new count-matched val the untuned base under-counts (MAE 0.92, bias -0.13), where on the old low-count val it over-counted (+0.35), which is exactly the val bias ruling 103 corrected.

## Variant A (encoder frozen, head-only): repeat proof + freeze proof PASS (for refuter review; NOT launched for a real run)
Trainer diff: commit 71b2b2c (`--freeze-encoder`), manifest `diar-train-clean-2026-09-24-b642fdd2`, seed 42, batch 8, lr 1e-5, 30 steps, count every 10. Two identical runs (`runs/run-2026-09-24-074359-…` and `…075003-…-nemotron-b642fdd2.json`): last weights hash 9e7484b04bed…, best weights hash 9e7484b04bed…, count curves identical (val MAE 0.921 / 1.0 / 1.079 / 0.895 at steps 0/10/20/30; V5 stayed 0.4 throughout, logged only). Freeze proof in both records: encoder sha256 identical before/after (db8221703416…), 98,202,624 encoder params, optimizer holds exactly the 1,027,923 head params, 0 encoder params in the optimizer, no encoder param requires grad.
Variant B diff (crops of >8-speaker windows at silences with per-crop re-indexed RTTMs, no turn split; oversampling toward `datasets/production-count-hist-2026-09-24.json`, a POPULATION target, never the test histogram): commit c1059a6; its repeat proof is pending its review.
Multiplicity note for any later PASS: V5 is 5 windows, so <= 0.2 means at most one speaker off in total, and three variants raise the chance of a lucky pass; the 30-window speaker-count page is the real check. Selection uses val only; V5/bench20 are scored once per variant on its pre-chosen checkpoint.

## Variant A result (run-2026-09-24-093745-nemotron-b642fdd2; refuter PASS #384; ruled val manifest b642fdd2; lr 1e-5, batch 8, seed 42, 300 steps, count every 25)
Encoder frozen, head-only (1,027,923 trainable params; freeze proof identical). Selection by VAL count error vs teacher only (best = step 250, val MAE 0.789 vs 0.921 untuned); V5 logged at every checkpoint but not used; V5 and bench20 scored ONCE on that pre-chosen checkpoint.
| step | val count MAE / bias | V5 counts (logged) |
|---|---|---|
| 0 base | 0.921 / -0.13 | 5,7,4,3,4 |
| 50 | 0.974 / -0.03 | 5,7,4,3,4 |
| 100 | 0.895 / -0.11 | 5,7,4,3,4 |
| 200 | 0.842 / -0.05 | 5,7,4,3,4 |
| 250 (best) | 0.789 / -0.05 | 5,7,4,3,4 |
| 300 | 0.868 / -0.13 | 5,7,4,3,4 |
| | V5 DER | V5 count err vs V | bench20 median DER | bench20 mean DER (excl. outlier) | bench count err vs pyannote.ai raw / prod-weighted | bench DER prod-weighted |
|---|---|---|---|---|---|---|
| base Nemotron | 0.414 | 0.4 | 0.150 | 0.230 | 1.47 / 1.35 | 0.240 |
| **A, step 250** | 0.383 | 0.4 | 0.115 | 0.213 | 1.37 / 1.33 | 0.225 |
| (leaky full-FT step 25 for reference, V5 0.342, bench median 0.144, before the clean split) | | | | | | |
- **No collapse.** With the encoder frozen the counts do not drift at all over 300 steps (V5 counts identical to base at every checkpoint, val bias stays around -0.05 to -0.13), unlike full fine-tuning (bias -0.6 to -0.7 by step 50). So the under-count is a full-encoder effect, and freezing prevents it.
- **But it does not learn counting either.** Val count MAE only improves 0.92 -> 0.79 (noise-sized: about one speaker off in 4 windows), and the V5 count stays at the base's 0.4. Head-only trades the collapse for the base's count ability, not more.
- Small DER gain (V5 0.414 -> 0.383, bench median 0.150 -> 0.115, bench count vs pyannote.ai 1.47 -> 1.37; production-weighted 1.35 -> 1.33 and 0.240 -> 0.225), i.e. a modest segmentation gain that survives re-weighting.
- Adoption bar (ruling 94.4) NOT met: V5 count error 0.4 > 0.2; V5 DER 0.383 vs the leaky step-25's 0.342 (the step-25 reference is contaminated; bench median is better than step-25's). Multiplicity: V5 is 5 windows, so <= 0.2 would mean at most one speaker off; one variant of three so far. Nothing here is adoptable for counts; A is a possible DER-only shadow candidate.
- Not logged in this run: the delivered-speaker-count histogram (refuter C1) was added after A launched (199893b); it will be in B's record.

## Delivered-count probe (no training; refuter C1 follow-up): the training chunks show far fewer speakers than the windows have
`delivered_counts_probe.py` (CPU only, NeMo's own train dataset class, one pass over the 129 train entries of b642fdd2 incl. the 17 crops; results `delivered_counts_probe.json`). Entries' teacher count: mean 3.15. Active speakers actually in each delivered item:
| session_len | nspk_bias | mean active speakers | items with 0 speakers | hist 0/1/2/3/4/5/6+ |
|---|---|---|---|---|
| 105 s (used so far) | 1.5 (released default) | **1.79** | **33%** | 43/12/32/23/13/4/2 |
| 105 s | 4.0 | 2.47 | 15% | 19/12/37/32/14/11/4 |
| 300 s | 1.5 | 2.41 | 18% | 23/14/37/24/15/10/6 |
| 300 s | 4.0 | 2.75 | 6% | 8/16/42/25/23/9/6 |
| 600 s | 1.5 | 2.74 | 9% | 11/13/39/27/24/9/6 |
(B's real training record shows the same at 105 s / 1.5: first 233 items mean 1.88, 31% empty.) So the low-count prior comes mostly from the sampler: a third of the training items are speaker-free chunks and the rest average under 2 speakers, while windows average 3.15 (test windows more). Full fine-tuning on that learns "few speakers", which is the under-count; the earlier 300 s probe (p2b, delivered mean about 2.4) drifted more slowly, consistent with this. Freezing the encoder (A) hides the effect rather than fixing it.
Proposal (B2, needs refuter review; one flag added: `--subsegment-nspk-bias`): 300 s crops with nspk_bias 4 (mean 2.75, 6% empty), batch 2, with B's crops; and the head-only twin A2 with the same sampler. Both on the ruled val manifest, same selection/scoring rules.

## Variant B result (run-2026-09-24-103740-nemotron-c4585089; ruling 133: PRODUCTION-MATCHED val c4585089; refuter PASS; C1 logged)
B = crops of the 4 windows with > 8 speakers (17 crops, no turn split) + oversampling toward the production histogram; full fine-tune, lr 1e-5, batch 8, seed 42, 105 s chunks, count every 25, patience 6. Train 127 entries (110 windows + 17 crops), val 40 windows on rd_aeeu5u4j / rd_ntajfras / rd_pw5gaugg / rd_xrn7wjsf. **Stopped at step 150 (6 checks without improvement); the best-by-val-count checkpoint is step 0, the untuned base** (val count MAE 0.675). So the evaluation of "B" in `ft-run-…103740…_scores.txt` is the base model's numbers, again NOT a fine-tune.
| step | val count MAE / bias | V5 counts (logged, never used) |
|---|---|---|
| 0 base | 0.675 / +0.13 | 5,7,4,3,4 |
| 25 | 0.825 / -0.53 | 3,5,2,3,3 |
| 50 | 0.800 / -0.55 | 4,6,2,3,3 |
| 100 | 0.875 / -0.53 | 5,5,3,3,3 |
| 150 | 0.900 / -0.55 | 5,6,3,3,3 |
- Same collapse as run 2 (bias +0.13 -> -0.5 within 25 steps) even with the dense-window crops. Delivered speakers (C1, first 247 items): mean 2.05 active speakers, 28% empty items, 6+ only 2%: the crops hardly change what the sampler shows the model.
- Balancing is a NO-OP again (all multiplicities 1) with the production target on this manifest (train shares already ~production: after crops 6+ is 14/127).
- Conclusion: crops + production-target balance do not fix the under-count. The sampler (chunk length / speaker bias) is the next lever: B2 (300 s crops + nspk_bias 4, delivered mean 2.75) and A2, both refuter-PASSed on the flag (9db357b), waiting for the GPU (A on c4585089 runs first).
Multiplicity: this is the second variant of three on the same V5 (5 windows); nothing here passes the adoption bar.

## Variant A re-run on the production-matched val (run-2026-09-24-105816-nemotron-c4585089; ruling 133 "re-score A for the record")
Retrained (not re-scored: the first A trained on rooms that are val in c4585089), head-only, lr 1e-5, batch 8, seed 42, 105 s chunks, count every 25, patience 6; train 110 windows, val 40 (rd_aeeu5u4j, rd_ntajfras, rd_pw5gaugg, rd_xrn7wjsf); freeze proof identical, optimizer = head only. **Stopped at step 150; best-by-val-count is step 0 (the untuned base), val count MAE 0.675**; later checkpoints 0.70-0.85 (bias +0.1 to +0.25), V5 counts identical to base at every checkpoint (5,7,4,3,4, error 0.4). So on the adoption val head-only neither collapses nor learns: no checkpoint beats the base, and the evaluation in `ft-run-…105816…_scores.txt` is the base model's numbers again. Delivered items (C1, 105 s / 1.5): mean 1.71 active speakers, 28% empty. Consistent with ruling 133: A not adopted.
Summary of the first three tries on the adopted val (all 105 s chunks, lr 1e-5): full fine-tune (B) collapses (val bias -0.5, V5 1.0-1.4), head-only (A) does not move (val MAE 0.70-0.85 vs base 0.675, V5 0.4): neither beats the untuned base on speaker count. Next: B2/A2 with the sampler fix (300 s crops + nspk_bias 4, delivered mean 2.75); the B2 flag repeat proof is queued on gcp-l4.

## B2 result (run-2026-09-24-113627-nemotron-c4585089) and WHERE the speakers go (no-training channel diagnostic)
B2 = B's crops + 300 s crops + nspk_bias 4 (delivered items, C1: mean 3.01 active speakers, 5% empty, 6+ 7%: now close to the windows' 3.15), full fine-tune, lr 1e-5, batch 2, 300 s sessions (peak 13.5 GB, 2.5 s/step). Stopped at step 150 (6 checks, no val-count improvement); **best-by-val-count = step 0 (the base)**, so its scored result is the base's (V5 count 0.4). Val count MAE 0.675 -> 0.90/0.83/0.83/0.78/0.83/0.85 (bias -0.45 .. -0.38); V5 counts (logged) 5,5,2,3,3 -> 5,6,3,3,3. **The collapse persists with realistic delivered counts, so the sampler is NOT the whole cause** (it slowed it at best).
`channel_diag.py` (inference only, base vs B2's last checkpoint, per output channel: seconds active at p>0.5 / peak probability):
| window (V count) | base channels (sec / peak) | fine-tuned channels (sec / peak) |
|---|---|---|
| maaacrdh (5) | 56 / 1.00, 11.6 / .92, 12.3 / .94, 4.3 / .79 | 41.9 / .93, 4.3 / .80, 1.3 / .66, 0 / .20 |
| d4t5tvg9 (7) | 150 / 1.0, 197 / .99, 13 / .98, 60 / .99, **166 / .99**, 40 / .89, 48 / .88 | 86 / .96, 170 / .96, 40 / .95, 117 / .96, **3.6 / .88**, 2.9 / .59, 0 / .30 |
| m6nq7upz (4) | 27 / .94, 9.6 / .82, 143 / .99, 56 / .98 | 5.6 / .86, 140 / .97, 52 / .96, 0 / .15 |
| yce79u6r (4) | 150, 282, 2.1, 19, 199 (all peaks .96-1.0) | 142, 268, 1.5 / .59, 15 / .71, 192 (nearly unchanged) |
| zyjykmwa (3) | 347, 70, 26 | 348, 79, 19 (unchanged) |
- **Minor speakers are what disappear.** The dominant speakers' channels barely change (zyjykmwa, yce79u6r), while low-talk-time channels lose activity or vanish: maaacrdh's 12.3 s and 4.3 s speakers drop to 1.3 s (peak .66) and 0 (peak .20); m6nq7upz loses its 4th channel; d4t5tvg9 loses three (its 166 s channel collapses to 3.6 s while others absorb its speech: a merge, not a fade). The count readout counts a channel if its peak crosses 0.5, so shrinking peaks of minor speakers is exactly an under-count.
- This is why decode thresholds (arm D) cannot fix it (the peaks are gone in the model output) and why freezing the encoder (A) leaves counts at the base level, but does not learn them.
- **Variant C (count-aware loss) is now the targeted test** (C1 sampler fix insufficient): `--count-loss-weight w` adds w * mean_i | sum_k max_t p_ik - N_teacher_i |, the L1 gap between the soft predicted count (sum of per-channel PEAK probabilities) and the teacher count. Gradient path (unit-tested in the worktree): loss -> |soft - tgt| -> sum over channels of max over time -> p at each channel's argmax frame -> logits; when under-counting every channel's peak logit is pushed up (negative gradient on 8 frames per item), the segmentation losses hold empty channels down. Permutation-free. Dark unless w > 0. Weight to be chosen on VAL only (grid 0.1 / 0.3 / 1.0 on B2's setting, then V5/bench20 scored once on the val-chosen checkpoint). Diff for eta-refuter-2 review before any launch.

## A2 result (run-2026-09-24-115519-nemotron-c4585089): head-only + B2 sampler — no collapse, no learning
Head-only (freeze proof identical), B's crops + 300 s sessions + nspk_bias 4 (delivered: mean 3.00 active speakers), batch 2, lr 1e-5, count every 25, patience 6; peak 9.6 GB, 2.2 s/step. Stopped at step 150; **best-by-val-count = step 0 (base), val count MAE 0.675**; later 0.70-0.875 (bias +0.1 .. +0.25); V5 counts identical to base (5,7,4,3,4, error 0.4) at every checkpoint. So head-only with the realistic sampler still neither collapses nor improves counting; the scored evaluation is the base's numbers. Table of all counting attempts on the adopted val (base val MAE 0.675, V5 0.4): full FT + crops (B) collapses; full FT + realistic sampler (B2) collapses (bias -0.4); head-only (A, A2) flat. The minor-speaker suppression under full FT (channel diagnostic) is the failure; C/C' target it directly.
