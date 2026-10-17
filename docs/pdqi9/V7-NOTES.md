# V7 notes (PDQI9-E-SPEC-v7.md, PDQI9-EVIDENCE-PLAN-v7.md; v1-v6 kept; changes tagged [v7])
Closure table
| Item | Status | Where |
|---|---|---|
| M1 name every medicine attribute; S-M plants frequency, duration, route by patient in merged label | closed | spec A4.1a.8 (drug, strength, dose, route, frequency, duration, instruction, each on its own cited segment), A2.1 S-M row (all 6 patient-merged and at least 2 attender-merged scripts), JSON `applies_to`; plan 2 item 8, 6, 0v7 |
| S1 test T24 failure makes four-arm results descriptive only, stated before S4 beside the withdrawal rule | closed | spec F S4 cell and S2 prereg freeze list, A2.5; plan 8 |
| S2 cluster-robust method for T28b and T28b-LOO | closed | spec A3.1 (BCa over doctors, 10,000 replicates, jackknife acceleration, two clusterings with the larger bound read, K_min 15 doctors with 50 or more trials each, raise-only after a coverage simulation; below K_min or with 0 false accepts, exact binomial plus doctor count, flagged); A3 T28b and T28b-LOO rows, JSON `impostor_interval`, F S2b and S2c, G10, G14; plan 6a, 8 |
| A3 note on the 2-false-accept trial count | closed, corrected | spec A3 arithmetic note; plan 6a. Exact minima: 1,843 / 2,784 / 3,610 / 4,381 for 0-3 false accepts |
| Accepted call: T28b-LOO carries the 0.2% bar | recorded | spec A3 T28b-LOO row, G13 closed; plan 6a |
| Accepted call: cosine vs label embedding and enrolled centroid | recorded | spec A4.1a.8 |
| Accepted call: order-item scope, advice and counselling at label level | recorded | spec A4.1a.8 |
Note on the A3 figure
- The brief gave 3,612 trials for 2 false accepts. By exact one-sided 2.5% Clopper-Pearson, 3,610 is the minimum: P(X <= 2) at p = 0.2% is 0.02499 at n = 3,610 and 0.02503 at n = 3,609. 3,612 also clears the bar. The spec prints 3,610.
My calls (for Fable)
- BCa chosen over an exact cluster-level bound: the exact bound counts doctors with any false accept, which is not the per-trial rate the 0.2% bar is set on.
- K_min = 15 doctors with 50 or more trials each: the record-only set spanned 20 doctors and about 137 trials per doctor, so it is reachable. G14.
- Two clusterings (true-speaker doctor and claimed-centroid doctor), with the larger bound read.
- With T24 failed, there is no A2.5 rescue: P-SYN four-arm runs rest on the same 3/3 spans.
Open / UNVERIFIED
- Whether K_min 15 gives adequate coverage; the preregistered beta-binomial simulation settles it and may only raise it.
- Whether real T28b trials will reach 15 doctors in both clusterings.
- The delta refute was not supplied as a file; its items are taken from the lead's brief.
- Carried from v6 notes: segments per S-V script, forced label merging on the rig, minimum embedding duration, LOO gap, margin provenance, voiceprint scorer id, unnamed worst room.
