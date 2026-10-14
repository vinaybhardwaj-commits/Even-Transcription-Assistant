# Refute: vj-link Phase L pilot (REPORT-PILOT.md @3431771, re-tier dd500ae: 0 HIGH / 2 MED / 8 LOW)

## PASS
- Clip selection (my C1/C2): per-turn single non-overlap turns, 4-5 s, per-turn ECAPA cos >= 0.60 to the voice centroid, from 3 different consults where they exist, seeded; contrast turns from another voice with cos < 0.30. Matches my request.
- LQ hash: the frozen sha12 04545aae3478 is what the prescribed awk yields on LQ-FREEZE.md @a9e5438 (I verified that). jev_link.py gates on the same awk behaviour. The header quirk (the awk line itself contains the BEGIN marker text) is disclosed and harmless.
- Truthful reporting: 0 HIGH (no link is tolerance-stable under Reading A, which HIGH requires). K1 was found by vj-link itself: one Cardiology voice (cos 0.98) linked to two doctors on 22/23 Sep. Exclusivity now marks it as a staff candidate.
- No truth used; no names or PHI in the repo files; tiers kept only in the key files, never on cards.

## Findings
- P1 MED IS NOT ABOVE THE PLACEBO. retier-report.json: placebo +4 h -> LOW 8 / MED 2, the SAME as the real links (LOW 8 / MED 2); placebo -4 h -> MED 0.
  - xday + exclusivity mostly reflects "a recurring room voice whose best doctor stays the same". A +4 h shift of a doctor who works the whole day in one room still picks the same doctor, so the placebo is weak and MED is not evidence of a correct link.
  - Consequences: (a) MED must never feed minting or truth without V's agreement (already required); (b) report the placebo MED rate on the page's evidence line, or at least to Fable; (c) a stronger placebo is needed: shift by whole days (the doctor's consult times from a DIFFERENT date) or swap doctors between rooms. Otherwise the placebo cannot show whether the tiers carry information.
- P2 SINGLE-LINKAGE CHAINING. groups() joins voices across room-days with union-find at cos >= 0.85, so A~B and B~C put A and C in one "same voice" group even when A and C are not >= 0.85. That inflates xday.
  - Fix: require every cross-day member to be >= 0.85 to the group's first voice (or complete-linkage), and report the group's minimum pairwise cosine.
- P3 K1 residual (my 201-204 note): a doctor's dedicated assistant passes xday + exclusivity. Please add the per-link check "does the linked voice hold the MOST speech time within that doctor's consults" and report links where it does not.
- P4 Rx evidence is weak (0-2 hits; English-script only). "Rx >= 1" can be one drug name, so HIGH's rxlq term is easy to meet by chance. Report the Rx hits of the placebo arm too, as a base rate.
- P5 LQ void on 6/10 (the paired control also says yes): ruling 203 asks for the cause by 21:30. Until then, LQ yes should be treated as uninformative.
