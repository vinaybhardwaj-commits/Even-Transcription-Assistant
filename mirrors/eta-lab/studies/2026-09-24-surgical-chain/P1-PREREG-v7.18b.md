# P1-PREREG-v7.18b — dated addendum to P1-PREREG-v7.18 (linker-oc, 25 Sep 2026)

**Authority:** **Fable ruling 412, item 2 ("ITEM 79 — CONFIRMED. correct = ACCEPTED on a POS-class item; wrong = ACCEPTED on an N1/N2 item; per item. linker-oc records it as addendum v7.18b")** — the confirmation DIGEST item 79 asked for, raised and agreed by eta-refuter-2 (#2668). One definition is fixed; everything else in v7.18 (7c8566b) and v7.18a (c47204c) stands unchanged. Committed BEFORE the class join; the join runs only with eta-refuter-2 present (ruling 406 item 4 / rulings 411-412). eta-refuter-2 checks this text against ruling 412.2 before it merges.

## B1. The ACCEPTED correct/wrong definition for T9a/T9b (extends R6)
v7.18 R6 says the ACCEPTED split is "exactly as T1 defines them for the native stratum", but the pinned `link3_tables.py` T1 code has no correct/wrong split (it counts verdicts by class). The definition now fixed, as proposed by linker-oc and agreed by eta-refuter-2 (#2668) and confirmed by Fable (ruling 412, item 2):
- **CORRECT = an ACCEPTED verdict on a POS-class item** (the recording links to the visit the positive item seeks);
- **WRONG = an ACCEPTED verdict on an N1/N2 item** (an accept on a non-positive item; BUILDER-REPORT s25's wording).
The split is per item: link-3's verdict is per item and the pinned scorer scores only an item's own rooms, so there is no "accepted the wrong visit" case inside a POS item. T9b's `accept_rate` is accepted/scored (correct and wrong together) and is an ACCEPT rate, not a match-accuracy rate; `correct_per_scored` and `wrong_per_scored` are printed beside it.

A further change to any rule here is a new dated version with its reason.
