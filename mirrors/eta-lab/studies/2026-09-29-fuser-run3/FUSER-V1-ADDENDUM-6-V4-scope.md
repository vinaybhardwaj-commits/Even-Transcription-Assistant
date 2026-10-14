# FUSER v1 — ADDENDUM 6: V4 scope correction (dated 2026-09-28, lid-debug). DRAFT until eta-refuter-2 witnesses.
Changes design §4 V4 (and the prompt's Whisper description) before RUN 2. DEV-phase change, made because of B4 RUN 1 evidence.

## Evidence (B4 RUN 1, eval-out/b4-dev-run.jsonl, d873a67; lid-debug read-only analysis)
whisper_low_pen_unanchored drops: 65 items / 81 tokens, 48 items in hi-en. By token script:
  hi-en whisper-auto: Devanagari 39, digits 9, Latin 18; kn-en whisper-auto: digits 5, Latin 9; hi whisper-auto: Devanagari 1;
  te whisper-forced-en: Latin 2; hi-en whisper-cap2: 1 digit + 1 Latin.
Example (clin_hi-en_1__babble_snr5): whisper-auto = "नमस्ते … ये 10 देज से हैं" (correct Hindi, correct digit) while SraVaani wrote
TAMIL (S1 class (a)). V4 dropped the only good Hindi evidence.

## Cause (design error, lid-debug)
V4 was written for L1 (FORCED-English Whisper invents fluent English on Indic speech). With REB's real auto-LID (M1 fixed), whisper-auto
decodes Indic speech IN the detected language (Devanagari etc.). A low p(en) then means "Whisper heard Hindi", not "Whisper's English is
unreliable". V4 applied the English-reliability gate to non-English text.

## Corrected V4 (replaces design §4 V4)
Per cited Whisper token, decide by the token's own segment and script:
 (a) whisper-forced-en and whisper-cap2 tokens (always English-decoded): unchanged — if slice p(en) < 0.9, cite only numbers/units/
     lexicon drugs WITH an anchor in an Indic track (ETR rules).
 (b) whisper-auto tokens in a segment whose extras.lid.detected != "en": treated as an INDIC track (same V1/V2/V3/V5 rules as sravaani
     and conformer; digits go through number_digits/V2 value checks like any track). Not subject to the p(en) gate.
 (c) whisper-auto tokens in a segment whose extras.lid.detected == "en": rule (a).
 Latin-script tokens inside a (b) segment (code-mixed English words, e.g. "metformin", "days"): allowed as copy; clinical-class ones
 (numbers, units, drug names) still need V2/V5 backing exactly as for any track (no gen, value checks, two-witness for lexicon_generic).
Prompt change to match: whisper-auto is described as a multilingual engine whose per-segment detected language is given; the "English
engine that invents English" warning applies to forced-en and cap2, and to whisper-auto only where it detected English.

## Consequences
- RUN 2 must use this V4, or it re-measures a known defect.
- Safety: no clinical token enters without the existing V2/V3/V5 checks; this widens which tracks can be cited, not what may be
  invented. Fixtures: (b)-segment Devanagari copy passes; (b)-segment digit with value check passes/fails as V2; forced-en token at
  p(en) < 0.9 without anchor still rejected; (c)-segment token without anchor rejected.
- Relevance to S1 class (a): whisper-auto Hindi becomes independent evidence when SraVaani mis-scripts under babble.

## Also requested for the RUN 2 report (design §6 metrics on DEV)
fused.v1 vs fused.v0 drug+dose item hit on clinical1 (per language, text_en and text_native) with the S1 scorer; conflict count;
gen share; omission count. PASS/REPAIR/FALLBACK shares alone do not say whether v1 beats v0.
