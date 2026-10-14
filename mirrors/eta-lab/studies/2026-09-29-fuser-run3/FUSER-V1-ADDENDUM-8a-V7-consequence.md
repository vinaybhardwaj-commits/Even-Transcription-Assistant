# FUSER v1 — ADDENDUM 8a: V7 consequence + drug support (dated 2026-09-29, lid-debug, designer). Amends ADDENDUM-8 (863700264349).
DRAFT until eta-refuter-2 witnesses. DEV phase; RUN 3 not started. Evidence: router-fix smoke 2 (#5847, 4f0d2cab).

## Evidence
With V7 as written ("a V7 clause drop counts as a CLINICAL drop, REPAIR/FALLBACK thresholds as for items"), 2 of 3 hi/kn smoke slices
fell back to v0: V7 dropped correct clauses (hi-en_2: "telmisartan 40 mg", "atorvastatin 10 mg"; kn-en_2: 5 clauses) because their
cited items are native-script sravaani/ctc copies, which V7 could not match to the lexicon or parse as numbers.

## Change 1: consequence (replaces the ADDENDUM-8 sentence above)
A V7-dropped clause is removed from text_en and counted (reason, per language) as an ENGLISH OMISSION. It does NOT count toward the
REPAIR/FALLBACK item thresholds and does NOT make the slice fall back. Reason: V7 guards text_en against invented content; removing the
clause already achieves that. Falling back to v0 would also discard v1's validated native items and all of the slice's English, with no
safety gain. Native-item drops keep today's REPAIR/FALLBACK rule unchanged.
Report: V7 omissions per language/reason next to the V6 omission count; G1-style wrong-dose counts are computed on post-V7 text_en.

## Change 2: drug support from native text (adds to ADDENDUM-8's support pool)
A drug named in a clause is also SUPPORTED if a cited kept item's text matches the SAME lexicon entry through the existing Indic-side
matcher of the two-witness rule (fuserv1 drug_match: coarse phonetic >= 0.8 and >= 0.1 margin over the runner-up entry; frozen
thresholds from #4501 D2). This is the Indic witness alone; it proves the drug is in the cited native speech. No new threshold.

## Unchanged
Numbers: support only from digits, English-by-ear parses, kept dose/duration entities, or norm w, as ADDENDUM-8. Native number words
(चालीस, ಐವತ್ತು ...) stay UNSUPPORTED until parser v2; those clauses are dropped as omissions (declared recall cost, per language).
router-fix's other choices (#5847): (2) "N times" is frequency, not a number: agreed (same as number_parse N1). (3) Latin words with a
consonant skeleton < 3 not drug-checked: agreed ONLY with an exact-match exception list. Checked the lexicon (rx_history excl 25/26 Sep):
real short generics exist ("iron", "urea"); most other short entries are unit/abbreviation noise ("mg", "ml", "iu", "vit"). So: a
Latin word whose skeleton is < 3 is drug-checked by EXACT (casefolded) match against the lexicon's short generic names (drop pure unit
and abbreviation keys: mg, ml, iu, vit, min), never fuzzily; record the count skipped.
(4) support pool = cited items' text + lexicon_generic w + kept entities whose native_items are all cited: agreed, plus Change 2.

## Fixtures
Clause dropped by V7 -> slice outcome unchanged by it (not fallback); omission counted. Clause "telmisartan" citing a Devanagari item that
drug_match maps to telmisartan (>= 0.8, margin >= 0.1) -> supported. Same clause citing a Devanagari item mapping to a different drug ->
dropped. Clause with "40 mg" citing only a native number word -> dropped (parser v1 scope).
