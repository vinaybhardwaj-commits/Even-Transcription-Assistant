# Frozen v5 (4830ae152bf4, u9-v5.0) vs blind labels on a FRESH set (judge-K, 40 items) — fleet, 24 Sep 2026

Set: 40 consults from the content-placed pool of 21-24 Sep that played no part in the v5 wording (V's 18 labelled excluded by token + time; neighbour-trimmed lx bounds; de-identified in-encounter text; Jev saw only de-identified text). Sampling by stratum: 24 items v5 gave a status, 6 gate-held, 6 below recall, 4 borderline: so every cell describes THIS SAMPLE, NOT the population, and NOT clinic talk (placed by procedure terms).
Labels: eta-refuter-2, blind (labels locked to ~/eta-data/refuter2/judge-K.json, sha256 0db3647c0face041..., before the key or any Jev output was opened). Conventions: CT angiography = category intervention (ct_status scored apart); a procedure done during the visit = proposed_now; a test is not a procedure; calcium-score CT out of scope. Low-confidence items (J02 J04 J06 J25 J31 J38 J40) and medium alternates (J15 J35) are reported apart from the headline (31 items). Script: v5_fresh_accuracy.py. THESE 40 MUST NEVER BE USED TO ADJUST v5.

## Gate (stage a0, cut 0.5)
| label \ v5 | kept | held |
|---|---|---|
| consult (38) | 34 | 4 |
| staff / case talk (2) | 0 | 2 |
The 2 staff items score 0.09 and 0.22 (both held). The 4 FALSE holds are real consults with gate scores 0.36-0.45 (just under the cut): J02 (garbled pre-op talk, label low confidence), J04 (503 turns, one line repeated 304 times, low), J37 (medium), J39 (medium; label status none). Of the 6 gate-held items sampled, 2 are true staff talk and 4 are consults: this stratum is a sample of 6 of the 15 held, so it does NOT give a population precision, but it does show the 0.5 cut removes consults whose transcript is garbled or looped. The cut was set on a development trial (V5-IMAGING-SCOPE-TRIAL.md: 12 shipped consults 0.65-0.96, 5 staff-talk items <= 0.38); here the 2 staff items score <= 0.22 but real consults reach 0.36. Changing the cut on these 40 would be tuning on the test set: that goes to a later version on a NEW fresh set.
J03 (label conditional, named no, described no): the gate kept it (0.86); it is a consult.

## Named / described (headline n = 31; all-40 in the script)
- NAMED: label yes 19 -> v5 yes 16, no 3; label no 12 -> v5 yes 5, no 7. (v5 says 'named' more often than the labels: mentions and history count as named by design; 3 of the 5 false yes are gate-kept.)
- DESCRIBED: label yes 13 -> v5 yes 10, no 3; label no 18 -> v5 yes 1, no 17.

## Status, end to end (v5 'none' = held, below recall or no status), ALL 40 (headline 31 in brackets)
| label \ v5 | proposed_now | conditional | already_done | mentioned_only | none | n |
|---|---|---|---|---|---|---|
| proposed_now | 10 [7] | 0 | 1 [1] | 0 | 6 [1] | 17 [9] |
| conditional | 1 [1] | 1 [1] | 0 | 1 [1] | 1 [1] | 4 [4] |
| already_done | 1 [1] | 0 | 3 [3] | 2 [2] | 1 [0] | 7 [6] |
| mentioned_only | 0 | 1 [1] | 0 | 0 | 0 | 1 [1] |
| none | 2 [2] | 1 [1] | 0 | 0 | 8 [8] | 11 [11] |
Per class (all 40): proposed_now: v5 predicts 14, 10 agree; label has 17, v5 finds 10. conditional: predicts 3, 1 agrees; label has 4, finds 1. already_done: predicts 4, 3 agree; label has 7, finds 3. mentioned_only: predicts 3, 0 agree; label has 1. Where the 6 lost proposed_now went: 3 to the gate (J02, J04, J37), 2 below recall (J25, J31: named 0.19, garbled, low-confidence labels), J40 no status; J12 (a manoeuvre performed in the visit, label proposed_now) reads already_done under v5 (a convention gap: 'done during the visit'); J35 (medium alternate) agrees.

## Category and the CT stratum (n small)
- CT angiography (J14, J27, J30, J33: label category intervention, ct_status proposed_now): v5 status proposed_now 4 / 4; v5 category = imaging_ct 4 / 4 (label: intervention). The v5 category text says angiography counts as an intervention, but the answer picks imaging_ct: a wording gap for a later version (page label 'Imaging: CT' shows it either way).
- Already-done CT (J07, J24): already_done 2 / 2. J11 (label status mentioned_only, ct conditional), J28: v5 conditional.
- J09 (CT coronary CALCIUM SCORE, deferred; label: out of scope, none): v5 reads status conditional (named 0.56): an out-of-scope test called a conditional procedure; v5's OUT list names 'calcium score' but 'CT ... calcium' still reads as a CT.
- Category among the 17 labelled operations: v5 operation 5, minor 1, imaging_ct 1, not reached 10 (stage b did not run: gate hold / below recall / no status).

## Reading (no single number)
Positives found: 10 of 17 proposed_now; the losses are dominated by the gate (3) and low-quality transcripts (2 below recall), not by the status question (1 J12 convention + J40). Precision of proposed_now 10 of 14 (7 of 11 on the headline set). Conditional is the weakest class (1 of 4 found, 2 false predicted). The gate is right on clear staff talk (2 of 2, scores <= 0.22) but over-holds garbled or looped consults (4 false holds of 6 sampled, scores 0.36-0.45). Everything above is ONE sample of 40 with n = 1-17 per cell; it is not a rate. Candidate changes for a later version (NOT applied; would need a new freeze and a NEW fresh set): the gate cut and its behaviour on looped / garbled transcripts; category rule for CT angiography; status wording for 'done during the visit'; excluding calcium-score CT explicitly.
