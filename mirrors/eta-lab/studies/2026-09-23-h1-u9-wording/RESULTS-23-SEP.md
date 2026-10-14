# H-1 U9 + H-2 wording trial — RESULTS (23 Sep 2026, scored, jev-1.13.0 via even-jev jev_ask)

Synthetic invented consults only (D1a); no real consult text sent. One jev_ask call per fixture, all
questions batched. Wording under trial: `U9-WORDING-DRAFT-23-SEP.md` (v1) and
`H2-AUDIT-COMPLETENESS-DRAFT-23-SEP.md`. "Designed" = my intended label when writing the fixture.
Cost of the whole trial: ~22 calls, ~17k input tokens (well under $0.001).

## H-1 v1, per question (9 fixtures: F1-F4 EN, F5-F7 HI-EN, F8-F9 KN-EN)
| question | strict vs designed | after correcting MY fixture errors | note |
|---|---|---|---|
| recommended (choice) | 8/9 | 9/9 defensible | F4 hedged case resolved cleanly (discussed_not_recommended 0.99). F6 miss = definition, see below |
| firmness (choice) | 6/9 | 7/9 | real confusion (F3); advised/strongly_advised/scheduled boundary soft |
| patient_response (choice) | 7/9 | 9/9 | both misses were MY fixtures (doctor-only text, no patient reply; Jev correctly said not_stated) |
| urgency_stated (noul) | 7/9 | 8/9 | F3 real (follow-up visit read as procedure timeframe, 0.91 confident-wrong); F9 was my label ("next week" IS a timeframe, 0.81) |
| cost_discussed (noul) | 9/9 | 9/9 | margins 0.03-0.04 (no) vs 0.97 (yes) |
| second_opinion_offered (noul) | 9/9 | 9/9 | margins 0.02-0.05 vs 0.85-0.96 |
| ALL | 46/54 = 85% | 51/54 = 94% | counts F6 defensible, F1 label corrected to advised, F5/F8 patient_response and F9 urgency labels corrected |

## Wording that confused Jev (v1) and the v2 fix
1. **Dependent-field leakage (F3, no procedure discussed):** firmness=scheduled (0.54, conf 0.43) and
   urgency=0.91, both triggered by "come back in a month" (a follow-up visit read as a booking / a
   timeframe). v2 adds "for the PROCEDURE itself" and "a follow-up visit is NOT a procedure booking".
   Re-run on F3: firmness not_applicable 1.00, urgency 0.17. Both fixed. Code should ALSO skip
   firmness/patient_response/urgency when recommended=no (arbitration in code, plan principle 4).
2. **advised vs strongly_advised vs scheduled boundary:** v1 F1 split three ways (0.39/0.33/0.28, conf
   0.24 = review band, an honest hedge). v2 (advised = clear opinion, "a date CAN be fixed later" is
   still advised; strongly_advised = repeats/warns about delay; scheduled = booking actually made)
   moved F1 to strongly_advised 0.77 and F5 to strongly_advised 0.94. Jev applies v2 consistently;
   **whether "should not delay too much" counts as strongly_advised is a definitional call for V**, not
   a model fault. F9 scheduled 1.00.
3. **recommended vs discussed_not_recommended on a passing negation (F6, "koi surgery ki zaroorat nahi
   hai abhi"):** Jev said discussed_not_recommended 0.98 because the doctor NAMED surgery and said it
   isn't needed. That matches the criterion as written. V to rule: does a one-line "no surgery
   needed" count as discussed (current wording) or as no?
4. **Worked as intended:** the hedged fixture F4 ("some surgeons would suggest it, I won't push you")
   -> discussed_not_recommended 0.99, firmness suggested 0.99, patient declined 0.70 (will_think 0.30).

## H-2 (4 fixtures, 5 nouls each): 19/20 = 95%
| question | score |
|---|---|
| indication_explained | 3/4 (G3 0.39: "your reports show this" names no finding; low-confidence hedge, review band, arguably correct) |
| risks_explained | 4/4 (G4 unnamed-reassurance "safe agide" -> 0.03: the "does not count" clause works) |
| alternatives_explained | 4/4 |
| recovery_explained | 4/4 |
| cost_explained | 4/4 (G3 "cost later" -> 0.02: the deferral clause works) |
G1 all five 0.96-0.99, G2 all five 0.01-0.03. No H-2 wording change needed.

## Fixture errors found (mine) — do not reuse uncorrected
- F5, F8: doctor-only text, so designed patient_response (will_think) was unsupported; Jev right (not_stated). Add a patient reply line to test will_think.
- F9: designed urgency=no but "next week ge OT date book" is an explicit timeframe; Jev right (0.81).
- F7: stray mixed-script "pचास" corrected to "pachaas" for the run. G1 (H-2): removed the "appendix - sorry, gallbladder" self-correction for the run.
- Indication (H-2) and alternatives have only 1 yes / 3 no across 4 fixtures; next round add fixtures with indication=no+alternatives=yes.

## Caveats
Nine synthetic consults is a wording probe, not a bench: per-cell accuracy here is directional. Real
Hindi/Kannada code-mixed transcripts are noisier than these tidy fixtures; the 30-consult V-labelled
set is the real test. `procedure` (free label -> fixed list) still not wordable without a taxonomy.

## Round 2 (24 Sep, same day's wording; 9 more synthetic calls) — v2 regression, will_think, H-2 coverage
- **v2 firmness/urgency does not regress the fixtures not re-run in round 1:** F2 not_applicable 0.98 / urgency 0.08; F4 suggested 0.99 / 0.21; F6 not_applicable 1.00 / 0.14; F7 strongly_advised 1.00 / 0.96; F8 suggested 0.99 / 0.05. All five identical in label to v1 and match designed. v2 is safe to adopt.
- **patient_response=will_think now tested (was untestable, my fixtures had no patient reply):** F8b (KN-EN, patient says they will think and report next visit) will_think 0.97; F5b (HI-EN, "will talk at home, tell you next visit") will_think 1.00. Both correct. patient_response is now 9/9 across the corrected fixtures.
- **H-2 coverage gap filled (two new fixtures):** G5 (alternatives + recovery + cost given; no indication, no risk named) -> 0.04 / 0.22 / 0.98 / 0.88 / 0.96, all correct (recovery 0.88 sits in the 0.5-0.9 caution band on a one-line "twenty days off work", the only sub-0.9 correct cell). G6 (indication + risks given; no alternative, recovery or cost) -> 0.96 / 0.99 / 0.03 / 0.04 / 0.01, all correct.
- **H-2 running total: 29/30 = 97% over 6 fixtures**; indication and alternatives now each have 3 yes / 3 no. The single miss is still G3's vague indication (0.39, review band).
