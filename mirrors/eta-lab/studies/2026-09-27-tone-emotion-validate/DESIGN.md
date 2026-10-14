# Synthetic emotion validation suite — design + pre-registered pass bar (W45.2, owner: tone, with diar-lab)

**Status: design only, no synthesis run yet.** Blocker before running for real: the box T4 GPU is
fully committed to hist-bulk's STT/diarize/emotion backlog during clinic hours (W43); the box
emotion replica (port 8086, pid confirmed live) is mid-backlog. Coordinating a run window with
Fable/hist-bulk before spending GPU cycles or the shared diag-rig TTS ledger (diar-lab confirmed
27 Sep 13:x: 48,218 of 60,000 chars once their in-flight confirm4 suite finishes, ~11,782 left —
diar-lab is CPU-only, no GPU/port-8086 conflict from them).

## Question
Does wavlm (`Aniemore/wavlm-emotion-v1-crosslingual`, the production emotion model) separate the
6 requested deliveries (neutral, calm, anxious, angry, sad, happy) reliably, and does reliability
differ by language (en, kn, hi, ta, te, ml)?

## Reuse, don't rebuild
`kit/diag-rig` (diar-lab, origin/main) already has: an ElevenLabs TTS backend with sha256 caching
and a shared 60k-char budget (`tts.py`), approved invented clinical dialogue frames per language
(`clinical.py FRAMES`), and a scoring harness pattern (`score.py`, `score_selftest_room.py`) whose
report conventions (ids/counts/scores only, failures first-class) this suite follows. New code only
for what doesn't exist: emotion-delivery control and a wavlm scorer (the rig has never called an
emotion endpoint).

## Same clinical lines, six deliveries
Per language, 2 fixed two-sentence lines from `clinical.py FRAMES` (case 0, diabetes/10 days,
Metformin 500mg — already-approved invented content, no new phrase gate needed):
- doctor line: `dx` + `inv` (e.g. en: "You have diabetes. Please get HbA1c test done.")
- patient line: `pt` + `confirm` (e.g. en: "Doctor, it has been 10 days. So Metformin 500 mg after
  food, right?")

6 languages x 2 lines x 6 emotions = 72 clips. **Revised from one-sentence lines** (see "run 1
finding" below) — a single frame line measured 1.1-1.4 s of speech on real clips, under the box
emotion service's `min_speech_s=1.5 s` gate; every clip came back `insufficient_speech`. Two
sentences per role clears the gate with margin (~2.5-3.5 s speech) while staying the two lines a
real consult would say back to back, not padding.

## Emotion control mechanism (deviation from tts.py's default model routing, documented)
ElevenLabs' only per-utterance emotion control is `eleven_v3`'s bracketed audio tags (verified
against ElevenLabs' own prompting docs, 27 Sep); `eleven_multilingual_v2` has no equivalent text
tag, only global voice_settings. Using v3 for **all six languages** in this suite (not tts.py's
default v2-for-en/hi/ta + v3-for-kn/te/ml split) so the delivery-control mechanism is the same
variable across languages — mixing model versions would confound "language" with "how emotion was
even requested." Tag per label, prefixed to the line text:
- neutral: no tag (baseline delivery)
- calm: `[calmly]`
- anxious: `[nervous]`
- angry: `[angry]`
- sad: `[sad]`
- happy: `[happy]`
ElevenLabs' own docs warn tag effectiveness is voice- and language-dependent and not guaranteed —
this is exactly the open question the suite measures, not an assumption it makes.

## Cost estimate (before spending)
72 clips, ~25-45 chars/line + ~10 char tag ⇒ estimated **≤4,000 chars** of the shared ledger
(≤~11,782 remain of 60,000 once diar-lab's in-flight confirm4 suite lands — leaves ~7.8k after
this suite, confirmed against diar-lab's live number, not the earlier stale 41,764 snapshot). One
voice (S1) to hold speaker identity constant; language is the only other confound besides emotion.
Cache-keyed by tts.py's existing sha256(backend|voice|model|seed|lang|text) — a rerun after a
scoring bug costs 0 additional chars.

## Room-acoustic variants — corrected after reading the actual code (27 Sep)
`score_selftest_room.py` / `selftest_pack.py` are SCORERS (they measure RT60/SNR from a recording
of a played physical stimulus); diag-rig has no callable "apply a room IR to an arbitrary wav"
function, and building that for real means the physical hardware self-test (play a stimulus into
a room speaker, record it back) — which needs a room command, not permitted from here (pane
brief: no room commands; W43: same). So this is a **software proxy**, not the SELFTEST rig itself:
a parallel-comb reverb (`emotion_suite.schroeder_reverb`) whose gain per comb is set so it decays
60 dB over a room's measured RT60 (blind estimate, `studies/2026-09-27-room-acoustics/`), plus one
of diag-rig's existing synthetic noise beds (`wavio.bed`, fan) mixed at that room's measured
median SNR (`wavio.mix_at_snr`). Both measured numbers come from real per-room acoustic profiles
(`/home/eta/eta-data/acoustics/room-profiles-2026-09-27.json`), not invented, but the reverb tail
itself is a statistical approximation, not a measured impulse response — reported as its own row,
labelled "room-acoustic PROXY," never conflated with a claim about the physical rig. Doubles the
clip count scored (144); zero additional TTS spend (post-processing of already-synthesized clean
audio, pure Python, no numpy dependency added to diag-rig itself — this script is standalone).

## Scoring
POST each clip to the box emotion replica's single-clip endpoint (`/inference/wavlm`, not the
production `/segments` presigned-URL path — these are local files, not room tape) once a GPU
window is confirmed. Record: top_label, all 7 label scores, unscorable reason if any (near_silent/
insufficient_speech — clips are ~2-4s, near the service's `min_speech_s`; report if that skips
non-neutral labels disproportionately, since that would be a suite artifact, not a model finding).

## Pre-registered pass bar (fixed BEFORE any real synthesis or scoring)
Per (label, language) cell, on clean audio:
- **Reliable**: top_label == requested label on ≥4 of the 2 lines x [clean+room] variants scored
  (i.e. the model's argmax matches intent on a majority of that cell's scorable clips), AND
  mean score for the requested label's own dimension ≥ mean score for every other label in that
  cell (separation, not just argmax luck on one item).
- **Unreliable**: everything else, INCLUDING any cell where >50% of clips are unscorable
  (near_silent/insufficient_speech) — a suite that can't get the model to listen is not evidence
  the model can't feel.
- Report a confusion matrix (requested label x top_label) per language, not just a hit rate — the
  order asks "where reliable, where not," and a hit-rate scalar hides which emotions get confused
  with which.
- Room-acoustic clips are reported as their own row, never averaged into the clean numbers — a
  reliability claim on clean synthetic speech shouldn't borrow support from a noisier condition
  that happens to score similarly, and vice versa.
- `neutral` is graded on the same bar as the other five, not treated as a free baseline — the
  coverage report already shows the production system runs 80.9% neutral on real room audio; if
  wavlm's neutral separation is itself weak, that number needs an asterisk, not validation.

## NOT built
No aggregate "average emotion reliability" score across languages/labels (masks exactly the
per-cell weakness the order asks to find). No claim that a `top_label` match on invented, acted
delivery predicts anything about how wavlm reads real patient/doctor affect — this suite bounds
"does the model separate deliberately clear performances," a ceiling, not a floor, on real-room
reliability.

## Run log
- **Run 1** (27 Sep, one-sentence lines): generated + scored for real (144 clips, clean + room-
  acoustic proxy). Nearly every `clean` clip came back `insufficient_speech` (gate bug above);
  the room-acoustic condition looked spuriously "more reliable" only because its added noise
  floor pushed clips over the RMS/duration gate, not because the model did better — reported here
  so the artifact is on record, not because run 1's numbers mean anything about wavlm. Kept at
  `~/eta-data/tone/emotion-validate/run1/` for the record, not cited as a finding.
- **Run 2** (27 Sep, two-sentence lines, Fable 13:20 authorised running through :8086 at low
  priority): 144/144 scored, 0 unscorable. Result: `neutral`/`happy`/`calm` partially reliable
  (5/12, 4/12, 3/12 cells); **`anxious`/`angry`/`sad` = 0/12 every language, both conditions**.
  Full table and caveats in `REPORT.md`.

## Arm 2 — Gemini 3.8 Flash as the listener (Fable ruling on #4506, 27 Sep ~13:20)
wavlm is ruled NOT valid for anxious/angry/sad (0/12 stands; never report negative emotion from
it). Next arm, same synthetic suite (run 2's 144 clips, zero new ElevenLabs spend — reuses
existing audio per Fable: "keep the char budget for top-up only"), same pre-registered pass-bar
shape: `emotion_judge_gemini.py` sends each clip's audio to Gemini 3.8 Flash via the identical ZDR
route `lang_judge.py`/`turn_translate.py` use (OpenRouter, `provider: {zdr:true, data_collection:
deny, allow_fallbacks:false}`, route-mismatch checked on every reply), asking for one of the same
six emotion words plus a 0-3 distress rating. No wavlm-style label crosswalk needed — Gemini is
asked for exactly the suite's own categories, so "reliable" only needs the requested label to win
the vote share among scorable clips (n still =2/cell, same thinness caveat as arm 1). Distress
rating is reported as a mean-by-requested-emotion sanity check (does distress rise for
angry/anxious/sad relative to calm/happy/neutral), not folded into the formal pass bar — it is a
different, more subjective axis than a forced 6-way choice. Results: see `REPORT.md` §Arm 2 once
the run lands.
