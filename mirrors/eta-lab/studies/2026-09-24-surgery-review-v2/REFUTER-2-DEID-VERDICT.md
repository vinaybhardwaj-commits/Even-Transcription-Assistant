# deid.py — Refuter verdict (eta-refuter-2, 24 Sep 2026, Fable ruling 43)

Under review: `studies/2026-09-24-surgery-review-v2/deid.py` (UNTRACKED in the shared eta-lab checkout at review time),
`deid_eval.py`, and fleet's real-pilot audit (ledger 519–521). Built by surg-deid; not by this session. I ran only
INVENTED sentences through it. The real pilot files were inspected for counts only (script and language), and no
real text was printed.

**VERDICT: PASS for the surgery-v2 PILOT as run. FAIL as the general de-id step (the planned lib/jev train item)
until G1–G4 are fixed and recall is measured on real text that contains identifiers.**

## Why the pilot is acceptable
- The pilot text is all English: 5 staging files, 872 turns, **0** fields with Indic script (my count). It was run with
  `--drop-nonlatin-orig`.
- fleet hand-audited all 872 de-identified turns and found no missed personal name. On the 13 turns that changed
  between de-id versions, Jev read the STRICTER earlier text (ledger 521).
- The CLI writes 0600, refuses to write inside git, refuses to overwrite its input, and prints counts only. Good hygiene.

## Why it isn't yet the general step: my adversarial INVENTED set (13 categories + 1 control)
Leaks in **6/13**; the control was untouched (0 tags). Held: spoken phone with tens ("ninety eight forty five…"),
Hindi digit words, address with PIN, DOB with a month name, spoken email, a relative by name, and a hospital-prefix UHID.
- **G1 (HIGH): Indic-script names are never removed, and the DEFAULT is unsafe.** Person entities containing Indic
  characters are skipped (deid.py:187), so Devanagari "सुनीता वर्मा" and Kannada "ರಮೇಶ್ ಗೌಡ" both passed through intact.
  Without `--drop-nonlatin-orig` the CLI only COUNTS these fields and ships them. stage_raw.py sets orig = en = the raw
  STT text, so for a Hindi/Kannada turn BOTH fields carry the names. Ruling 43 requires the original script to be
  handled. Fix: fail closed by default (drop/omit Indic fields, or refuse to write) until a script-capable NER is proven.
- **G2 (HIGH): fuzzy doctor matching keeps patients.** Over 10 roster doctors (no names printed):
  (a) a patient named one letter off a roster doctor (same surname) was KEPT IN FULL in 9/10 (Roster._close, ratio
  0.79/0.88); (b) a patient sharing the consult doctor's SURNAME kept that surname in 8/10 (_around_own_doctor /
  own_doctor_match, ratio 0.75/0.79). Common Indian surnames make (b) routine. This contradicts "errs toward removal".
  Fix: exact roster tokens plus a CURATED list of known ASR spellings per doctor, not a similarity ratio. A bare
  surname only with a Dr/Doctor honorific.
- **G3 (MEDIUM): lowercase names:** "yes ramesh kumar is my father" → "kumar" survives (a lowercase hit needs score ≥ 0.85).
- **G4 (MEDIUM): age over 89 without "years":** "aged 94" survives (the AGE regex needs a years/saal/… suffix). The ruling
  names "the exact age of anyone over 89".
- **Recall on real text is UNMEASURED.** fleet reports the 30 hand-checked real turns hold 0 identifiers, so "92%" is
  recall on the builder's own invented set (38–39 plants). Before production, measure recall on real turns that DO
  contain identifiers (e.g. select turns where the regex/NER layer or a keyword such as "name", "number", "address"
  fires, then hand-check the misses among them).

## Addendum — ruling 49 (10:30) and the EPI roster
- G2(b) (the consult doctor's own surname is kept) is ruled KEEP by Fable: accepted, no longer a finding.
- **G2(a) measured at the new roster size:** invented patient names = 30 common Indian first names × 20 common surnames = 600.
  With the 20-name voiceprint roster, 0/600 are wrongly kept. **With the 265-name EPI roster, 11/600 (1.8%) are kept as
  "doctors" by the fuzzy ratio alone (exact roster names excluded).** Whitelisting more names with ratio matching
  scales patient-name leaks. Use exact tokens plus curated ASR variants.

## Re-check of bc9798b (the committed tool, ruling 49): verdict UNCHANGED (pilot PASS, general-step FAIL)
- The same invented adversarial set on the committed code still leaks in **6/13**: G1 (Devanagari and Kannada names pass),
  G2a (a name one letter off a roster doctor is kept), G3 (lowercase "kumar"), G4 ("aged 94"); G2b is ruled KEEP. Control untouched.
- The tightened roster rule (a doctor needs the roster name's first AND last token, nothing extra) helps: 600 invented common
  patient names against the 285-name roster (EPI + voiceprint) → **8 fuzzily kept (1.3%)**, down from 11 (1.8%), plus 1 that is
  exactly a roster doctor's name (surg-deid's known weak spot 1). Fuzzy ratio matching remains the source; exact tokens plus curated ASR variants
  would remove it.
- surg-deid's own weak-spot list (6 items) is accurate and matches mine. Good disclosure.

## Re-refute of 3a4c9aa (24 Sep ~11:40): G1, G3, G4 CLOSED; G2a mostly closed; residual canonical collisions
My same invented set, run on 3a4c9aa's deid.py extracted from the commit: **2/13 "leak", and both are the ruled-KEEP case**
(the consult doctor's own surname, ruling 49). Line by line:
- **G1 CLOSED:** Devanagari and Kannada names are gone. Indic-script fields are omitted by DEFAULT in orig AND en, inside redact().
- **G3 CLOSED:** "yes ramesh kumar" is removed. **G4 CLOSED:** "aged 94" is removed.
- **G2a one-letter-off CLOSED:** over 10 roster doctors with no consult doctor set, a one-letter-off first name kept 0/10 and its surname 0/10.
  (My earlier harness had left the consult doctor set for case 2, so its "leak" there was the ruled-keep surname.)
- **Residual (MEDIUM, for the general step):** 600 invented common names vs the 286-name roster → 8 kept (1.3%). **Only 1 is an
  exact first+last match** with a roster doctor (unavoidable by name). **7 are kept only via the new ASR-spelling canonicalisation**
  (aspirates, -ee/-i/-y, doubled letters). Canonicalisation merges distinct spellings, and so distinct PEOPLE: it is a
  fuzzy match under another name. Suggest canonical matching only for the consult's own doctor or after Dr/Doctor, and exact otherwise.
- **Not citable yet:** 3a4c9aa is on NO branch (git branch -a --contains is empty), so it must be pushed or merged before anyone cites it.
  The CLAUDE.md line still cites bc9798b (which lacks G1–G4).
**Verdict:** fine for the v3 items (raters are PHI-cleared; the residual affects only what Jev sees, 1.2% of common names
coinciding with a canonical doctor name). The general step is close; it needs the canonical-collision fix plus real-text recall.

## a1ffdb9 (on origin/main; 3a4c9aa was rewritten to 7306500 by a rebase, content identical): canonical-merge residual CLOSED
- Code: without a Dr/Doctor honorific, is_doctor() compares RAW tokens against the RAW roster (first and last significant
  tokens, nothing extra, order-insensitive). canon() is used only behind an honorific. So without an honorific, a spelling
  merge cannot keep anyone, BY CONSTRUCTION.
- My 600-name check: 7 kept, all exact first+last collisions with a roster doctor's name (patients who happen to share a doctor's
  name). My first split ("1 exact / 6 canonical") was MY classifier's error: it counted in-order pairs including one-letter
  initials, while the tool drops initials and ignores order. Corrected here.
- The same adversarial set: only the ruled-KEEP case remains; one-letter-off patients are kept 0/10.
- **Remaining, and inherent to ruling 49's whitelist:** ~1.2% of common patient full names equal a roster doctor's name and are
  kept. No name-only rule can separate them. Context (speaker role, the consult's own doctor) is the only lever, and that is a design question, not a defect.
- **Cite a1ffdb9**, not 3a4c9aa or bc9798b (the CLAUDE.md line cites bc9798b, which lacks G1–G4).
