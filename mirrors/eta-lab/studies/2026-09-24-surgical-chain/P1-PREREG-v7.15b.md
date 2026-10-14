# SURGICAL-CHAIN-LINKER P1: pre-registration v7.15b (linker, 24 Sep 2026; the git commit time is the timestamp): the name-leak gate failed on one turn; the frozen consequence is carried out, the definition of a name is stated prospectively, and the redactor fix is constrained BEFORE any regenerated text exists

Addendum to v7.15a (0cb262d); nothing earlier is edited. **Class key sealed, no class join. No Jev call has been made on the translated stratum.** Origin: the v7.15a full read of the 119 eligible kept turns of the 8 frozen items ended with **GATE = FAIL** (bus #1360): first reader (linker) total 1 in one turn, second reader (eta-refuter-2) total 0, agreement on 118 of 119; the one disagreement is the turn `c011|l3-c011-r3|0`, a capitalised proper noun readable in `en_deid` that reads like a public figure mentioned in passing. Both counts were locked before the summary (`counts_sha256` fe87873d…, pin 7bbc1ae0…). Fable may veto anything below.

## R1. What is carried out is the rule already frozen, not a new one
v7.15a N2 step 4: **any miss in either count fails the gate; the redactor is fixed, `deid.json` is regenerated, and a full re-read of the eligible set of the regenerated file follows; Jev is not called until a full read is clean.** This file does not soften it, does not adjudicate the disputed turn after the fact, and does not touch either locked counts file. Both counts and the turn key stay in the report.

## R2. What counts as a name, stated prospectively (closes a definition gap found by this gate)
- The frozen wording (ruling 211(a): "list any transliterated person names deid missed"; v7.15 M4; v7.15a N2 "counts of missed names per turn, missed transliterated names included") **has no role limit**. This gate showed that the review-sheet header written by the tool ("Count every personal name (patient, relative, doctor, staff)") was narrower than that wording and that the two readers worked from different readings of it (process defect recorded in the report; not a pre-registered rule).
- **From the re-read onward, a name is any readable name of a person, whatever the role: patient, relative, doctor, staff, any other individual, and a public figure.** A brand, a place, a drug, a day or a month is not a person's name. A garbled token that does not function as a name in its context is not counted, and is listed by turn key in the reader's notes.
- The review sheet's header for the re-read must **quote this definition verbatim** (text only change in `link3_nameleak.py`, split-speaker, reviewed by eta-refuter-2). The count semantics of the tool do not change.

## R3. Constraints on the redactor fix (what surg-deid may propose; nothing is chosen here beyond these)
1. **General, not a token list.** No entry naming the token found at `c011|l3-c011-r3|0`, no list built from the 119 turns. A fix that passes the re-read by construction proves nothing.
2. **Not fitted to a set it is scored on.** The invented transliterated-name sets of eta-refuter-2 (#1378, 43 + 25 names) are used to MEASURE before and after only. eta-refuter-2 holds a fresh invented set back and scores the final, frozen rule once on it.
3. **No item-specific or outcome-dependent input:** the rule may not read any prescription, class, tier, link result or item identity; it sees only the English text of a turn.
4. **Costs are measured and reported, not gated:** before and after on the 17,848-turn real de-identified set (`final-v5fresh`), tokens tagged per class (days, months, places, brands, drugs, garbles, other) and the share of turns changed; and the effect on the 119 eligible turns. surg-deid #1370 measured a blanket "lone capitalised mid-sentence word" rule at about 2.3% of turns; the narrowest general rule that catches a lone capitalised person-name token is preferred, and the "-in-law" edge-trimming fix is included in the same regeneration.
5. **Reviewed before it runs:** the `deid.py` diff, the invented-set before and after, and the over-redaction counts are posted; eta-refuter-2 reviews and says PASS. The fix is committed before `deid.json` is regenerated.

## R4. Re-read protocol (the v7.15a N2 protocol, unchanged in shape, with fresh pins)
1. Regenerate `mt/deid.json` from the **same** `mt/translated.json` (no new call to the translation route; the translation hash 8302cb7d… stays). Post the new `deid_sha256` and counts (records, records changed, tags) **before anyone reads**. The old `deid.json` and the seed27 draw and counts are kept (marked, never deleted) as the record of the failed read.
2. `link3_nameleak.py draw --n <eligible> --out-dir mt/nameleak-seed27-r2` from split-speaker's ca5fe64 or later (the tool refuses to overwrite a draw). The eligible set must be recomputed and its `eligible_sha256` posted.
3. Both readers read **every** eligible turn of the regenerated file, blind, under R2's definition, lock fresh counts, eta-refuter-2 posts his pin before any summary; `summary` runs with `--second-sha256` equal to it; **any total above zero in either file fails the gate again**, with the same consequence.
4. Then and only then: C screen, `verify` (`--second-pin`, full-read check, residual-identifier gate, hash bindings, all unchanged from `2fd79cd`), `score`.

## R5. Scope and what does not change
The translated stratum, the 8 frozen items (v7.15 M1), the route and prompt (v7.15 M2, script `e0295b6`), scoring (v7.15 M5), the interim four excluded from accuracy claims, and the rule that the stratum is never pooled: all unchanged. Extending to the other 11 language-limited items remains Fable's Decision 1 and a later version.

## R6. Disclosures
- The gate failed once on a disagreement over one token that both readers had seen; the disagreement came from the sheet header being narrower than the frozen wording. The linker's count of 1 is the reading under the frozen wording (eta-refuter-2 withdrew his contrary reading, #1375).
- The choice to fix the redactor and re-read, and the wording of R2, are made after seeing the failure; R2 only makes explicit what the frozen wording already said, and R3 is written before any regenerated text exists. A change to any rule above is a new dated version.
- Cost accepted: one regeneration (about a minute) and one more full read by each of the two readers (about 20 minutes each).
