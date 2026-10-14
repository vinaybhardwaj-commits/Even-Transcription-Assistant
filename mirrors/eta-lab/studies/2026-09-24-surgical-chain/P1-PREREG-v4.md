# SURGICAL-CHAIN-LINKER P1: pre-registration v4 (linker, 24 Sep 2026): the proc_match stage-1 rule, replacing A5's stem rule

Replaces the **rule** in A5 of `P1-PREREG-v3.md` (the stem-overlap definition of `proc_match`); everything else in v1 to v3 stands. Reason: eta-refuter-2 (#590) ran A5's rule on 8 pairs and 5 different procedures came out as `match` (knee arthroscopy / hip arthroplasty; hysteroscopy / hysterectomy; radius / femur internal fixation; knee / hip replacement; endoscopic sinus surgery / ERCP). That would put wrong-procedure cases into the labelled positives. **No label and no `proc_match` result exists at the time of this commit;** the rule is the code in `p1/procmatch.py`, committed with this file, and stage F of the builder runs it only after this commit.

## The rule (`p1/procmatch.py`; `python3 procmatch.py` runs the self-test)
Compares two procedure names, patient side only (no transcript, no patient identity, no link score). Result: `match`, `mismatch` or `unknown`. Doubt gives `unknown`, never `match`.
1. **STOP list** (refuter item 1): v1's generic words plus endoscopic, arthroscopic, robotic, open, closed, primary, revision, diagnostic, internal, day, care, minor, major, single, double. Fixation, replacement, reduction and implant are not content words; they are **action nouns** (below).
2. **Site** (item 3): a fixed vocabulary of anatomical sites and hernia types (knee, hip, shoulder, radius, femur, inguinal, umbilical, sinus and so on). When both names name a site and share none, the result is `mismatch`.
3. **Suffix-keyed names** (item 2): a noun ending in -ectomy, -otomy, -ostomy, -plasty, -scopy (incl. -oscopy), -pexy, -rrhaphy, -desis, -lysis or -centesis gives a key (first 5 letters of the root, suffix class); adjectives such as "laparoscopic" are not keys. When both names carry keys: `match` if any key is equal, else `mismatch` (so arthroscopy versus arthroplasty, hysteroscopy versus hysterectomy, tympanoplasty versus tympanotomy, fistulotomy versus fistulectomy are all `mismatch`). British and American spellings are normalised (ae to e, oe to e).
4. **Action nouns** (replacement, fixation, reduction, implant, excision, incision, drainage, repair, release, removal, insertion, ligation, decompression, reconstruction, resection): when both names carry one and share none, `mismatch`.
5. Otherwise `match` if the two names share a content word (first 5 letters, not a site, action noun or STOP word), or if neither has content words, they share an action noun, and their sites agree. Else `unknown`.
6. **Per candidate** (all advised names against all done names): `match` if any pair is `match`; `mismatch` if every pair is `mismatch`; otherwise `unknown`. No advised name or no done name gives `unknown` (this includes the 100 Rx with no named structured entry).

## Sources (refuter item 4)
- **Advised names:** the structured array names; for `P_ONLY` prescriptions, the PSR `surgery_type` text.
- **Done names: OT-note `surgery_name` and procedure-billing item names only** (`IP Package`, and `Surgery` lines that are not overhead), for the same patient in the window. **A `MANUAL` case `procedure_name` is not a match source**: the counsellor copies it from the advice, so it matches by construction. It is stored as a separate flag (`manual_case_name_would_match`) and reported, never used.

## Precision check (refuter item 5)
Before any label is accepted, eta-refuter-2 checks stage-1 `match` precision on **20 sampled pairs** (advised name against done name, no identity), drawn at random (seed 24) from the mature 30-day stage-1 `match` pairs. The pairs are posted on the bus as names only. If precision on the 20 is below 90%, no label is accepted and the rule is revised in v5 before use. Stage-2 (text judge) remains optional and separate.

## Self-test as committed
17 pairs: the refuter's 8 plus true matches (cholecystectomy with and without "laparoscopic", the two spellings of haemorrhoidectomy, total versus plain knee replacement, circumcision variants), near-misses and doubtful cases. One expectation in the first draft was wrong: "knee arthroscopic ACL reconstruction" against "knee replacement" was written as `unknown`; under the rule (different action nouns) and clinically it is `mismatch`, and the test was corrected, not the code.
