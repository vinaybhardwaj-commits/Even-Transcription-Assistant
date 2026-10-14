# VAD v3 — method review (eta-refuter-2, 23 Sep 2026)

Scope: `orders/VAD-V3.md` (5cc547e) and the v2 scorer it inherits (`studies/2026-09-23-vad-v2/run_ab.py`).
Reviewed BEFORE any v3 result exists. No audio or transcript seen.

**VERDICT: FIX BEFORE RESULTS ARE USED.** The design is sound in outline. Four defects would let a config
pass that shouldn't: the pass bar, one-sided truth, the listening pack, and tuning on the scoring windows.
Fixes M1–M8 below. The ones marked **(pre-register)** must be written into the study dir and committed
BEFORE the 200-window scoring run. A rule written after the results can't be told apart from a rule fitted to them.

## 1. Pass bar (≤2% every window, p95 ≤1%)
- **M1 — zero/low-speech windows.** `cut_stats` returns `(0, 0)` when the teacher has no speech, so the window
  scores 0% and passes whatever the VAD cut (run_ab.py:69–70). At the other end, a window with 20 s of teacher
  speech fails at 0.4 s cut. Fix **(pre-register)**: a window counts toward the % bar only if teacher speech
  is ≥ 60 s. Below that, use an absolute bar (≤ 2 s cut). Report how many windows fall in each regime.
- **M2 — seconds lost ≠ utterances lost.** 2% of a window can be tail trimming (harmless) or a whole short
  answer ("haan", a dose) deleted (clinical). Fix **(pre-register)**: also count teacher segments ≥ 0.3 s that
  are ≥ 80% cut. The bar is 0 such segments in every window, or a stated small absolute count.
- **M3 — boundary collar.** pyannote.ai boundaries are imprecise to a few hundred ms. Scoring with no collar
  rewards padding fitted to pyannote's boundary style. Fix: score with a ±0.25 s collar and also without,
  and report both. The ruling uses the collared figure.
- The thresholds themselves (2% worst, p95 1%) are reasonable, provided M1–M3 are applied. At n≈200,
  "every window" is a real claim: 0 failures in 200 held-out windows bounds the true failure rate at < 1.5%
  (rule of three). Fewer than ~100 test windows cannot support "every window".

## 2. pyannote.ai as truth (H1 + listening pack)
- **M4 — the truth is audited in only one direction.** H1 checks only spans where Silero is silent and
  pyannote says speech. Speech that pyannote.ai itself MISSED is invisible to every arm's loss figure, and
  that bias favours aggressive arms. Fix: also run Whisper large-v3 on a random sample of the spans the
  WINNING arm cuts, taken from teacher silence. That audits the arm's actual cuts, not just Silero's blind spots.
- **Whisper can't answer "clinical or not".** TV, radio and corridor talk are real speech, and Whisper
  hallucinates on noise (see the phrase-loop defect in this repo). words/sec and no_speech_prob separate
  speech from non-speech, not clinical speech from background talk. Fix **(pre-register)**: rule now what the
  truth is. Recommended: truth = any human speech in the room. Non-clinical speech is labelled but is NOT
  removed from the loss figure unless V's pack says so. Any relabelling is decided once and applied
  identically to ALL arms. It is never decided per arm, and never after the leaderboard has been seen.
- **M5 — the listening pack is biased and too small to measure a rate.** "The 12 longest spans from the
  4 outliers" selects exactly the steady TV/babble cases most likely to confirm H1. With 12 clips, 10/12 "not
  speech" gives a 95% interval of about 52–98%. That can falsify H1; it can't measure how often it holds.
  Fix: draw the clips at RANDOM (random offset within each span) from all disputed spans, stratified by
  window. Blind the condition: shuffle the order and interleave both positive controls (teacher speech that
  Silero also keeps) and negative controls (teacher silence). Use three buttons: clinical speech /
  speech but not clinical (TV, other) / not speech, plus "can't tell". Aim for ~30 clips if V's time allows.
- **Circularity.** Arm C (pyannote seg-3.0) is from the same family as the teacher and will agree with it for
  lineage reasons. Flag this in the leaderboard. Don't treat C's agreement as independent evidence.

## 3. Test set (20 → 220)
- ≥10 windows per room is right. **Also stratify** by teacher speech-density tercile, by time of day
  (clinic hours vs idle) and by day. Include every room whose mic produced a v2 outlier.
- **State the sampling frame.** Only windows that already carry pyannote.ai labels are eligible. Say how
  those windows were chosen for pyannote.ai in the first place (drained, OPD 5, date range). A frame that
  excludes quiet or broken rooms can't certify "every window".
- Arm A's real level log exists only for dates after `bench_level_sample` began (zero rows for 18–22 Sep in
  v2). Compare arms on the same subset, or report arm A separately on its own subset.

## 4. Leakage — held-out split REQUIRED
- **M6 — the 20 bake windows are contaminated.** They chose Silero's 0.15/1200/500, Arm B's 1.10×p3 floor,
  0.5 s hangover and 0.3 s blip, and they motivated H1–H3. They are dev data permanently. They may never
  appear in a pass/fail table.
- **M7 — split by room-day, not by window (pre-register).** Adjacent windows in the same room share
  mic, noise and staff. A window-level split leaks. Fix: freeze a manifest before any run, committed with
  ids only. DEV = the 20 bake windows + ~half the new room-days. TEST = the other room-days, stratified so
  each room appears in both. Every grid, padding sweep, ensemble choice, arm selection and tie-break runs
  on DEV only. TEST is scored ONCE, on the single frozen config (or frozen per-room configs). A re-tune
  after seeing TEST burns TEST.
- **M8 — per-room configs overfit fastest.** With ~10 windows per room they must be tuned on that room's
  DEV room-days and scored on its TEST room-days. A room with fewer than 3 TEST room-days falls back to
  the global config.
- Per-window adaptive rules (e.g. Arm B's own 3rd-percentile floor) are unsupervised and are not leakage.
  Their constants (1.10, 3rd percentile) are hyper-parameters and belong to DEV.
- **Pre-register the objective too:** minimise audio sent, subject to M1–M3 on TEST. Report ₹/night at the
  TEST-set sent %, not the DEV figure.

## What would make me sign off the results
A frozen manifest (DEV/TEST by room-day) committed before the scoring run. One TEST scoring pass of the frozen
config(s). Tables showing M1 regime counts, M2 segment drops and collared/uncollared loss. The M4
cut-span audit. A blinded, random listening pack. I will rerun the scorer on the TEST manifest myself.
