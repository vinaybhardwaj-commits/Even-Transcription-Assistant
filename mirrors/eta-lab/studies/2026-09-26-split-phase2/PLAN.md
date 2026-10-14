# SPLIT phase-2 plan: Nemotron turn-finding trained on pyannote.ai labels (W27.6b)
Author: split (CC-personal sonnet), 26 Sep 2026. DRAFT to Fable. NO training starts until Fable says so. Figures marked (est) are not measured.

## 0. Where we start (recomputed from runs/, RESULTS.md, Neon counts)
- Untuned Nemotron-3: V5 DER 0.414, count error vs V 0.4; bench20 median DER vs pyannote.ai 0.150 (~15 points from the teacher, target is 3).
- Five fine-tunes on the clean split all trade speaker count for teacher-DER: they under-count (bias -0.6 to -0.7 by step 200-300). Best so far: p1 step 25, V5 DER 0.342, bench median 0.144. Nothing has passed the count target (<= 0.2 on V5).
- So phase 2 is not "train longer": the first job is to stop the merge-speakers drift, then close the DER gap.

## 1. Data (read-only counts, Neon via neon-select 26 Sep)
- pyannote.ai teacher labels: 452 windows (454 rows) created 22-24 Sep (last row 24 Sep 13:36 UTC; 0 after; +277 local rows). At 900 s/window = ~113 audio-hours. Latest dataset manifest c4585089: 173 source windows, 19 excluded (test room-days), 114 train, 40 val (4 room-days).
- Reference set from 337e: 317 windows with pyannote.ai vs Nemotron scores (RESULTS-REFERENCE.md), usable as extra eval; NOT extra training data until checked for overlap with the 15 permanent test room-days.
- Labels are not growing: no pyannote.ai row after 24 Sep 13:36 UTC (live transcription off by V, Fable ruling 21:45). Open question for Fable: is pyannote.ai still called in production? If not, new training data needs a paid backfill (cost unknown) or the 4,167 vault windows relabelled through pyannote.ai (each window = 1 API call, price to confirm with V).
- Hard rules kept: split by room-day; 15 test room-days (V5 + bench20) never trained on; manifest in git, audio only under ~/eta-data.

## 2. Training method (order of trial, each needs a refuter-2 read of trainer changes)
1. Count-safe fine-tune first: freeze encoder, train head only; oversample windows with >= 4 speakers; the 4 windows with >8 teacher speakers get cropped, not dropped; short run (25-100 steps, lr 2e-6).
2. Count-aware auxiliary loss (count_loss_* flags already exist in train_nemotron.py, weight 0.0 so far).
3. Only if 1+2 hold V5 count <= 0.4 and val count bias within +/-0.2: longer run on the full label set.
Selection = lowest val DER vs teacher subject to |count bias| <= 0.2 (a checkpoint that fails count is never shipped, as the earlier runs showed).

## 3. T4 budget (vLLM holds 0.55 of 15.36 GB, leaves ~6.9 GB; nvidia-smi showed 12.9 GB of 15.4 GB in use on 26 Sep incl. 8.4 GB for vLLM, so check free memory before each run)
- Past runs used peak 13.5 GB at batch 2 x 300 s crops on the L4. That does NOT fit. Need batch 1, 105 s crops, gradient checkpointing, fp16 (T4 has no native bf16); expected peak ~5-6 GB (est, unmeasured; first step is a 10-step memory probe).
- Time: L4 2.76 s/step + 1,058 s count-eval per run. T4 ~2.5x slower (est): ~7 s/step, eval ~45 min. One 300-step run + eval ~ 80 min (est); a 100-step run ~ 60 min. Weekly cycle (1-2 runs + full eval) ~ 2-3 GPU-hours, ~10-12 h for the first 4 weeks, all under flock /home/eta/gpu.lock, night slots, yielding to STT/hist-bulk.
- Fallback if 6.9 GB proves too tight: ask Fable for a window with vLLM paused, or an L4 hour (GCP exit says no). Not assumed.

## 4. Weekly eval vs the exit test (Mon 06:00 IST, box T4, PROD-untouched)
- Exit test (DIAR-LAB.md): DER within 3 points of pyannote.ai on held-out room windows AND no worse than pyannote.ai on V5, two weekly evals in a row.
- Each week report on the same frozen sets: bench20 median + mean DER vs pya, V5 DER and counts vs V (4,7,5,3,4), val count bias, embedding check for doctor matching, plus the untuned base as control. Table appended to studies/2026-09-26-split-phase2/WEEKLY.md, run record in runs/.
- Note the held-out set is tiny (20 windows / 5 V windows); a 3-point gap is inside its noise. Propose adding ~60 pya-labelled windows from unseen room-days to the frozen eval before week 1 (needs labels, see section 1).
- Stop rule: two weekly evals without improvement -> report to Fable. Pass twice -> Fable decides on switching pyannote.ai off; V informed.

## 5. Decisions needed from Fable
1. Is pyannote.ai labelling still running? If not, approve a backfill budget.
2. Approve trainer changes in section 2.1 (refuter-2 reads them) and the T4 memory probe.
3. Which night slot on the T4 (hist-bulk shares it).

## 6. Fable rulings 26 Sep 21:45
Backfill: none until Fable decides on windows x price (pyannote.ai rate is not in the repo; ask V). Trainer 2.1 + 10-step T4 probe approved, refuter-2 reads the diff first. T4 slot 01:00-05:00 IST nightly under /home/eta/gpu.lock, yield to hist-bulk, never touch vLLM. Eval +~60 windows approved once labels exist. Cleanup of 337e bucket/staged audio on HOLD.
