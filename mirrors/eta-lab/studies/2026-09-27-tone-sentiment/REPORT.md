# W45.3 pilot — real 24 Sep consult, end to end (27 Sep 2026)

Pipeline: `extract_turns.py` (R2 read-only, merges `room_diarize_window.segments_json` micro-
segments into turns, deletes the window clip immediately after cutting) → `turn_translate.py`
(Gemini 3.8 Flash, ZDR OpenRouter route) → Jev sentiment (3 questions validated in `DESIGN.md`).
Run via `tone/run_real.sh` per Fable's 13:00 permission rule. Per V's 12:55 ruling (`RULINGS-
2026-09-27.md`), no de-identification step. **No transcript text in this report or in git** —
counts/scores only, same convention as every other report in this repo; raw per-turn text lives
at `~/eta-data/tone/sentiment-pilot/` (lab-side, not git, not the bus).

Pilot window: `bw_ayd5y9w5_1790228700000_primary` (24 Sep, chosen for having the most role-
attributed speakers of the day's diarize-ok windows).

## Extraction
371 raw diarization micro-segments → **153 merged turns** (same-speaker segments within 1.5 s
merged, split before 30 s, turns under 0.8 s dropped as VAD blips). **92 attributed to the
clinician** (voiceprint match), **61 unattributed**.

## A role-terminology correction (checked against real data, not assumed)
`DESIGN.md`'s original wording ("doctor vs patient/attender") assumed `room_turn_speaker.role`
takes values like "doctor"/"patient". On real data it only ever takes **"clinician"** (voiceprint-
matched) or is **NULL** — patients/attenders are never assigned an explicit role, exactly as
`TONE-DESIGN.md`'s original design warned ("a two-speaker room isn't proof the other voice is the
patient"). Corrected the Jev question wording to `clinician` vs `unattributed` (not the clinician
— most likely the patient or an attender, but not asserted as fact). This is a real finding for
whoever builds the REB fuser or any downstream consumer: don't expect a "patient" role value.

## Translation
153/153 turns translated, 0 errors. 139 en, 5 kn, 4 hi, 3 ml, 2 ta by Gemini's own language guess
(not independently verified against a ground truth — this window's language mix, not a claim about
detection accuracy).

## Sentiment pilot (20 of 153 turns: 10 clinician, 10 unattributed, random seed 42/43)
| | n | mean distress (0-3) | mean satisfaction (0-2) | mean empathy (Noul) |
|---|---:|---:|---:|---:|
| unattributed (patient/attender) | 10 | 0.68 | 0.64 | — |
| clinician | 10 | — | — | 0.17 |

Qualitative check (structure only): the single highest-distress turn in the sample (2.28/3, high
confidence) is a patient describing fear of a specific symptom — a correct, clean catch, not a
false alarm on ordinary clinical language. The highest-empathy clinician turn (0.62) is a
reassurance during a pre-procedure explanation, not a random clinical instruction scoring high by
accident. Most clinician turns score low empathy (mean 0.17) because most clinician speech in a
consult is procedural/instructional, not because the question is miscalibrated — matches the
question's own intent (empathy CUES, not overall tone).

## What this pilot does and does not establish
- **Does**: the full pipeline (extract → translate → role-join → Jev score) runs end to end on
  real patient audio without errors, and produces sentiment numbers that track real content in
  spot checks. Worth scaling to the rest of the window (133 more turns) and more windows.
- **Does not**: validate translation accuracy at scale (no ground truth checked beyond spot
  reading), validate Jev's calibration against a labelled set, or say anything about whether this
  window is representative of 24 Sep or any other day.

## Per Fable 13:22
Results are lab-side only — tone stays "Not shown yet" in the lab viewer; nothing here is
clinician-facing. Both W45.2 emotion arms (wavlm, Gemini) and this distress rating are kept as
shadow signals, not surfaced, pending V's ruling on what to show.

## Next
- Scale to the rest of window `bw_ayd5y9w5_1790228700000_primary` (133 more turns) and a handful
  more 24 Sep windows before drawing any distributional conclusion.
- Switch the target day to 26 Sep once hist-bulk's backfill reaches it (tracked in W45.1).
- When REB (`/home/eta/oc/REB-SPEC-v1.md`) ships its own per-turn English text, retire this
  Gemini-audio stopgap and consume REB's track instead — don't duplicate REB's eventual "Gemini
  audio→English direct" test arm, which is the same idea REB already plans to build properly.
