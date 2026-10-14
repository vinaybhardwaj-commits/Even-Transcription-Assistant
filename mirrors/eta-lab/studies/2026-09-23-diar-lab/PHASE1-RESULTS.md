# diar-lab phase 1: local diarizer vs pyannote.ai — results

**Question:** can a free local diarizer get close to pyannote.ai precision-3 on our clinic rooms? Order: `orders/DIAR-LAB.md`. Compute moved Mini→Yoga→E2E GPU box (`e2e-lab`, T4) per `orders/RULINGS-23-SEP-1540-E2E.md`; this file covers the E2E-box runs. Full narrative/incident log: `~/dev/_fable/scratch/diar-lab/REPORT.md` on the Mini (or its current path after the `_fable`→`eta-lab` rename there).

Reference note: pyannote.ai precision-3 is a strong reference, not ground truth. V's 5 hand-labelled windows are the only human truth (speaker counts: 4, 7, 5, 3, 4).

## Arm A — stock `pyannote/speaker-diarization-3.1` (GPU)

**V's 5 windows** (DER/JER vs pyannote.ai, collar 0.25s):

| window | V count | hyp count | pyannote.ai count | abs err vs V | frame agreement | DER | JER |
|---|---|---|---|---|---|---|---|
| w1 | 4 | 5 | 4 | 1 | 0.850 | 0.173 | 0.319 |
| w2 | 7 | 7 | 7 | 0 | 0.556 | 0.659 | 0.693 |
| w3 | 5 | 2 | 5 | 3 | 0.542 | 1.324 | 0.946 |
| w4 | 3 | 4 | 3 | 1 | 0.881 | 0.213 | 0.457 |
| w5 | 4 | 3 | 4 | 1 | 0.888 | 0.283 | 0.535 |

Mean abs speaker-count err vs V: **1.20**. Mean frame agreement: **0.743**. Mean DER: **0.530**. Mean JER: **0.590**.

**20-window bake-off set** (vs reused pyannote.ai precision-3 reference, n=20):

Mean abs speaker-count diff: **2.60**. Median frame agreement: **0.853**. **Median DER: 0.232, median JER: 0.521** (mean DER/JER are 1.62/0.49 — skewed by one pathological outlier, `bw_9j4z2ze3_1789989300000_primary`, DER=26.26 on what's almost certainly a near-silent/short-reference window; excluding it, mean DER=0.328, consistent with the median). Speed: **~70s per 900s (15min) window on the T4** (one window ran 38.9s — it was a genuinely shorter ~1011s-requested source window, not a speed anomaly).

Note: the original CPU bake-off (2026-09-22, local 3.1 vs pyannote.ai) reported median frame agreement 0.62 on 16/20 computable windows. This GPU rerun of the *same stock model* gets 0.853 median on the same 20 windows — the gap is almost certainly a methodology difference in how frame agreement was computed between the two runs (this run's script does an optimal one-to-one label permutation on 100ms frames), not a real model change; flagging rather than claiming an improvement.

## Arm B — `pyannote/speaker-diarization-community-1` (pyannote.audio 4.x, GPU)

Two real bugs hit and fixed along the way (not covered up):
1. **Crash 1:** `RuntimeError: torchcodec is not available` — pyannote.audio 4.x's default audio loader needs `torchcodec`, which doesn't match this box's CUDA build (`libnvrtc.so.13` missing). Fixed per Fable's suggestion: `diar_run4.py`/`diar_run20.py` (api=4 path) now load audio via `torchaudio.load()` directly and hand pyannote a preloaded `{'waveform','sample_rate'}` dict — pyannote's own documented fallback, avoids the native-lib dependency entirely.
2. **Crash 2:** `AttributeError: 'DiarizeOutput' object has no attribute 'itertracks'` — community-1's pipeline call returns a `DiarizeOutput` dataclass (`speaker_diarization`, `exclusive_speaker_diarization`, `speaker_embeddings`), not a bare `Annotation` like 3.x. Fixed: read `output.speaker_diarization` before calling `.itertracks(...)`.
   Also found and fixed a **watcher bug**: the shell wrapper around the first crash printed its "done" marker unconditionally regardless of the python process's exit code, so the background watcher reported success on a crash. Wrapper now checks `$?` and writes a distinct `ARM_B_FAILED` line; the watcher checks for `Traceback`/`FAILED` before the success marker on every poll.

**V's 5 windows:** n_speakers = 6, 3, 2, 2, 3 for w1–w5 (V's truth: 4, 7, 5, 3, 4) — worse speaker-count match than Arm A on this small sample (abs err 2, 4, 3, 1, 1 → mean 2.2 vs Arm A's 1.20). Speed ~41s/window.

**20-window set (n=20):** mean abs speaker-count diff **1.40** (vs A's 2.60), median frame agreement **0.898** (vs A's 0.853), median DER **0.192** (vs A's 0.232), mean JER **0.455** (vs A's 0.487). Same pathological outlier window (`bw_9j4z2ze3_1789989300000_primary`) still blows up the mean DER to 1.61 for both arms — not arm-specific.

**A vs B, head to head:** B (community-1) wins on every 20-window metric (speaker-count accuracy, frame agreement, median DER, JER) but loses to A on V's-5 speaker-count accuracy (mean abs err 2.20 vs A's 1.20) — a real trade-off, not a rounding difference. Order weighs pyannote.ai-referenced DER/JER/frame-agreement (all favor B) alongside V's 5 as "the only human truth" (favors A on this one dimension, n=5). **Decision: tuning Arm C on B (community-1)** — it wins the larger, more-varied 20-window comparison across every metric the order asks for, and the V's-5 gap is a single dimension on a 5-sample set. Flagging this as a judgment call, not a settled fact.

## Mini MPS cross-check (Ruling: orders/RULING-MINI-NIGHT-LAB.md, 20:00-10:00 IST window)
Ran Arm A on V's 5 windows via MPS on the Mini in parallel with the T4 grid sweep (own venv at `/Volumes/Air Drive/eta-lab-night/diar-lab/`, `flock /tmp/mini-lab.lock`, memory-guard wrapper, `PYTORCH_ENABLE_MPS_FALLBACK=1`). Results: n_speakers 5,7,2,4,3 for w1-w5 — **identical** to the original T4 run, confirming determinism across hardware. Speed: ~64-87s/window (mean ~77s) vs the T4's ~59s/window — MPS is a bit slower but fully usable as a second accelerator, exactly as the ruling intended.

## Arm C (tuned, community-1) — done
`min_speakers=2, max_speakers=8` (fixed, per order), clustering-threshold grid {0.50, 0.55, 0.60 (default), 0.65, 0.70}, 20-window set only for tuning (V's 5 held out, per order). Cross-hardware validated on gcp-l4 (Arm B stock, V's 5): n_speakers 6,3,2,2,3, identical to the box's original run.

Grid (n=20, medians — means are all ~1.59 DER / ~0.44 JER, skewed by the same pathological outlier window across every threshold, not threshold-specific):
| threshold | median DER | median JER | mean abs count diff | median frame agree |
|---|---|---|---|---|
| 0.50 | 0.201 | 0.444 | 1.35 | 0.888 |
| 0.55 | 0.192 | 0.453 | 1.35 | 0.898 |
| **0.60 (chosen)** | **0.192** | **0.431** | 1.40 | 0.898 |
| 0.65 | 0.195 | 0.424 | 1.40 | 0.898 |
| 0.70 | 0.201 | 0.439 | **1.30** | 0.898 |

**Honest finding: the threshold sweep changed almost nothing** (DER range 0.192-0.201, JER 0.424-0.453 across the whole grid — no threshold is a clear winner). **Chosen: 0.60**, tied-best on median DER and literally the untuned default — picked over a marginally-different value because there's no real signal to tune on here, not because 0.60 measurably beats the alternatives.
**Held-out validation on V's 5** (min=2/max=8, threshold=0.60): n_speakers 6,3,2,2,3 — **identical to unconstrained Arm B**. Mean abs count err vs V: 2.20 (unchanged from B). Mean DER 0.500, mean JER 0.595 (unchanged from B). **The min/max_speakers=2/8 constraint made zero difference on either test set** — the natural predicted speaker counts already fell inside [2,8] for every window. Arm C is not a real improvement over stock Arm B on this data; reporting that plainly rather than dressing up a "tuned" result.

## Arm D (+ voiceprints) — BLOCKED, confirmed empty (not just unauthorized)
Fable authorized a read-only query (`node kit/neon-select.mjs`, single SELECT) against the Mini's production Neon DB for `voice_centroid` (migration 0113: `domain, generation, embedding, embedding_model, embedding_dim, n_samples`, active = `retired_at IS NULL`). Ran it: **the table has zero rows, in any domain, active or retired.** Confirmed via a read-only `GROUP BY domain, active` count (also empty). This isn't a permissions or access-path problem — the schema exists but nothing has ever been written to it in production. Arm D cannot run: there is no doctor centroid to match diarized clusters against, regardless of the 0.7323 threshold named in the order.
(Context, unchanged: `orders/PLAN-v3.md` §D describes a *different*, newer per-turn-embedding voiceprint result (EER 14.9%, threshold ~0.73) from another pane's workstream — likely the eventual replacement for this table, not yet landed as `voice_centroid` rows.)

## Phase 2 status
- **ToS**: pyannote.ai Terms of Use §9.1 by default prohibits training a competing model on its outputs; V has written permission overriding this — unblocked.
- **Pipeline scaffolded** (`eta-lab/training/diar-lab/`): `nightly_export.py` (verified against real Neon data — found 33, later 35, `pyannoteai`-labelled windows and counting, correctly excludes the permanent V's-5/20-bench test set), `build_dataset.py` (rebuild-from-manifest + hash verification, per the durability proof requirement), `train_segmentation.py` (writes an honest `SCAFFOLD_NOT_RUN` run record rather than a fabricated result).
- **R2 access is the real blocker, now precisely diagnosed**: `Even-Transcription-Assistant/.env.local`'s `R2_ACCESS_KEY_ID`/`R2_ADMIN_ACCESS_KEY_ID` are the literal redacted-placeholder string, not real keys (confirmed by another pane, VAD-v3, via boto3's own length-mismatch error — never by printing the value). No working R2 credentials exist anywhere on this box right now. Needs V/Fable to supply a genuine key pair or point at where they live.
- **Label volume**: 33-35 `pyannoteai`-labelled windows with clip audio exist right now, across ~10 rooms (max 6/room) — real but small; not enough yet for a meaningful first fine-tune even once R2 access lands.
