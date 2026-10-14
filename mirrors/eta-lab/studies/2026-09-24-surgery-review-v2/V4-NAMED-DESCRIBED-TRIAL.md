# V4 wording trial: NAMED and DESCRIBED as independent questions (fleet, 24 Sep 2026, ruling 143)

Trigger: V rated V3-02 (working id Q32) "described but not named (tympanoplasty)"; v3's single recall question required both, and the page then hides every other question when no procedure is named.
Method: v4_trial.py. De-identified in-encounter text only. Each item asked twice (Jev is non-deterministic); table = mean p(yes); noise (max-min of the two runs) was <= 0.06 on every cell. Candidate wording = two independent noul questions:
- NAMED: the doctor SAYS the name of a specific procedure (generic words 'surgery/operation/procedure/scan/test' alone are not a name); proposed, done or mentioned all count.
- DESCRIBED: the doctor explains what a procedure would involve or how it affects this patient, whether or not it is named.
Development trial only, NOT a score; the v3 freeze (a29f22245670) is untouched and no v4 sha is frozen yet (needs Fable's OK). Blind-judge labels from eta-refuter-2 (v3 gate); V's labels are not used.

| shipped id (working) | judge | v3 combined | NAMED | DESCRIBED |
|---|---|---|---|---|
| V3-01 (Q20) | proposal (CT angio) | 0.74 | 0.98 | 0.46 |
| V3-02 (Q32) | proposal; V: not named | 0.82 | **0.06** | **0.97** |
| V3-03 (Q28) | proposal, minor | 0.44 | 0.63 | 0.25 |
| V3-04 (Q34) | look-alike (history) | 0.38 | 0.21 | 0.35 |
| V3-05 (Q27) | proposal | 0.72 | 0.92 | 0.70 |
| V3-06 (R06) | proposal | 0.90 | **0.19** | 0.95 |
| V3-07 (W66) | proposal | 0.84 | 0.87 | 0.92 |
| V3-08 (Q06) | look-alike (conditional) | 0.41 | 0.94 | **0.17** |
| V3-09 (W95) | look-alike (advised against) | 0.86 | 0.51 | 0.84 |
| V3-10 (W150) | look-alike (optional) | 0.77 | 0.97 | 0.70 |
| V3-11 (Q36) | proposal, minor | 0.52 | **0.08** | 0.70 |
| V3-12 (Q29) | proposal (CT angio) | 0.76 | 0.97 | 0.52 |
| 10 negatives | none | 0.01-0.07 | 0.03-0.21 | 0.02-0.21 |

Findings:
1. The split does what V asked: V3-02 reads named 0.06 / described 0.97. The same pattern (described, not named) shows on V3-06 and V3-11, so V3-02 is not a one-off; the v3 single question hid it.
2. It also separates the other look-alike shape: V3-08 (a procedure NAMED but hardly described) reads named 0.94 / described 0.17. Under v3 its dependent questions (status, raised_by) were hidden because 'described' was no; that is the item type where a rater most needs the status question.
3. Negatives stay low on both (max 0.21), so a low recall cut on max(named, described) is still recall-oriented without flooding stage (b).
4. Weak spots: V3-04 (procedure in history) reads low on both (0.21/0.35) and V3-01/V3-12 (CT angio) describe at ~0.5: the 'described' wording is stricter than v3's combined for imaging-suite procedures.
Recommendation (needs Fable/V): freeze a v4 with these two questions; recall gate on max(named, described) >= 0.25; page shows status / raised_by / cost / second_opinion when described = yes OR named = yes (Jev's or the reviewer's answer), firmness / patient_response only when status = proposed now.
