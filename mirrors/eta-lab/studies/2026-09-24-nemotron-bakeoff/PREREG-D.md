# PRE-REGISTRATION — ruling 210 bounded try (variant D): DER objective + class-weighted BCE for minor speakers, brief speakers kept
Written and pushed BEFORE any code for it runs and before any result exists (git timestamp is the record). Owner diar-lab, gcp-l4, ONE run, wall-clock cap 3 h from launch, then stop and wait for the human speaker-count page (>= 20 rated).

## What is fixed in advance
- Data: adopted production-matched manifest `diar-train-clean-2026-09-24-c4585089` (train 110 windows + the 4 dense windows as 17 crops; val 40 windows on rd_aeeu5u4j / rd_ntajfras / rd_pw5gaugg / rd_xrn7wjsf). Brief (< 3 s) speakers are KEPT exactly as the teacher labelled them (no relabel, no drop).
- Sampler (B2, delivered mean ~3.0 speakers): crops of > 8-speaker windows, 300 s sessions, nspk_bias 4, batch 2. Full fine-tune, lr 1e-5, warmup 20, seed 42, bf16-mixed, max 300 steps, checkpoint scored every 25 steps.
- Loss: NeMo's own losses unchanged EXCEPT the BCE terms (ATS and PIL) become a weighted BCE. For each item and speaker channel k with S_k active frames in the chunk (from the labels handed to the loss, so the weight follows the speaker through the permutation search) and S_max the largest S_k of the item: positive frames of k get weight w_k = clip((S_max / S_k)^0.5, 1, 4); negative frames weight 1; mean over valid frames x channels. No count loss (variants C/C' are closed).
- Objective for SELECTION and stopping = DER, not count: DER vs the pyannote.ai teacher on the 40 val windows (pyannote.metrics, collar 0.25, overlap scored, same as every earlier table), computed at every checkpoint in the offline 30.4 s decode. Best = lowest val DER; stop after 6 checkpoints without improvement or at 300 steps or at 3 h. V5 counts are logged, never used.

## Success criterion (decided now)
The selected checkpoint counts as a DER-ONLY SHADOW CANDIDATE if ALL hold, else the try FAILS:
1. val DER <= base val DER - 0.02 (absolute), base = step 0 of this same run;
2. guardrails on the same checkpoint: val count MAE <= 0.775 (base 0.675 + 0.10); V5 count error <= 0.4 (the base's); bench20 count error vs pyannote.ai <= 1.55 (base 1.47 + 0.08);
3. V5 and bench20 are scored ONCE, on the val-selected checkpoint only (one try, no multiplicity).
This is NOT adoption. The adoption bar of ruling 94.4 is unchanged (V5 count error <= 0.2 and bench count error below the teacher's); pyannote.ai stays primary for counts whatever this returns. The result is reported as DER-only shadow candidate or fail, next to the human page when >= 20 windows are rated.

## Not allowed after seeing results
Changing the weight exponent / cap, the selection metric, the guardrail numbers, or running a second try. The trainer diff goes to eta-refuter-2 before launch (as for A/B/C).
