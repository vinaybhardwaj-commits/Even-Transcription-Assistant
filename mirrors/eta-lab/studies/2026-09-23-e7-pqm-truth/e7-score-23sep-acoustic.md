# E-7 score — source=acoustic (encounter-clock-smooth-v1)

Match rule: interval overlap >= 50% of the shorter interval (orders/E7-PQM-TRUTH.md rule 2). Scored against `e7-truth-23sep.csv` (voiceprint-confirmed room-days only).

## Overall

- PQM consults (truth): 14
- Hypotheses (acoustic): 14
- Recall (PQM consults with a matching hypothesis): 3/14 = 21.4%
- Precision (hypotheses matching a consult): 4/14 = 28.6%
- Splits (one PQM consult matched by >1 hypothesis): 1
- Merges (one hypothesis matched by >1 PQM consult): 0
- Start error (s): median 175.2, p90 369.6 (n=3 matched pairs)
- End error (s): median 327.6, p90 356.8 (n=3 matched pairs)

## Per room-day

| Room | Date | Truth | Hyp | Recall | Precision | Splits | Merges | Start err med/p90 (s) | End err med/p90 (s) |
|---|---|---|---|---|---|---|---|---|---|
| Cardiology OPD | 2026-09-23 | 3 | 5 | 0/3 (0.0%) | 0/5 (0.0%) | 0 | 0 | n/a (no matches) | n/a (no matches) |
| OPD 3 | 2026-09-23 | 8 | 4 | 2/8 (25.0%) | 3/4 (75.0%) | 1 | 0 | 139.0/175.2 | 233.0/356.8 |
| OPD 5 | 2026-09-23 | 3 | 5 | 1/3 (33.3%) | 1/5 (20.0%) | 0 | 0 | 369.6/369.6 | 327.6/327.6 |

## Notable: room-days with both truth and hypotheses present, zero matches

- **Cardiology OPD 2026-09-23**: 5 acoustic hypotheses and 3 PQM consults, but their time windows don't overlap at all (~-230.9 min gap between the two windows) — not a near-miss on the 50% threshold, a genuinely disjoint time range.

No transcript text or patient identifiers above; `token_uid`s and hypothesis ids are opaque.
