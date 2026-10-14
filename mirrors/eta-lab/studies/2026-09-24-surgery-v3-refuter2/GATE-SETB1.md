# Surgery v3 selection gate, SET B tranche 1 (Q07 Q17 Q28) — eta-refuter-2, 24 Sep 2026
Ids and codes only; per-item reasons off git (~/eta-data/refuter2/judge-setB1.json, 0600). Judged from judge-B/ only; verdicts locked
before opening gate-report-B.json. **Blindness caveat:** fleet's hand-off (#258) disclosed Jev's call on Q17 before I read it.
Scope applied: V 12:10 (CT angiography counts). For imaging, my proposed default (#246) holds until Fable/V rule.

## Leakage: PASS
0 token / time / patient overlap with V's 18 labelled consults; 0 shared token or patient with set A's kept items.

## Verdicts
| id | code | note |
|---|---|---|
| Q07 | Y-now | an intervention proposed now for this patient and described; edge turns are other patients (minor boundary noise) |
| Q28 | Y-minor (borderline) | a bedside manoeuvre performed and explained in the consult (minor OPD; no instrument). **BOUNDARY:** its in-encounter span contains clinicians' case talk about a DIFFERENT, absent patient's operation. Grey it, or a rater will score that as this patient's proposal |
| Q17 | N | the 34-min re-cut spans ≥4 encounters; no procedure proposed to anyone. **Duplication:** it shares 154 long turns with set A's Q09 and contains all 69 of the old Q17's, so the new cut swallowed its neighbours. Drop it |
**Share (tranche 1):** real 2/3 (Q07, Q28), but Q28 is minor and borderline. Firm proposals: 1/3.
**Cross-check:** Q16 (set A, kept) shares 0 turns with Q09 or Q17, so it is a separate conversation. My earlier same-teleconsult suspicion is withdrawn.
**Combined, if Q07 and Q28 are added to set A's 9 kept:** 8/11 real; minor OPD 2/11 = 18% (≤20%, at the limit if Q28 counts).
