# E-7 score — source=fused (encounter-clock-smooth-v1)

Match rule: interval overlap >= 50% of the shorter interval (orders/E7-PQM-TRUTH.md rule 2). Scored against `/Volumes/Air Drive/eta-data/2026-09-23-e7-pqm-truth/e7-truth.csv` (voiceprint-confirmed room-days only).

**Energy-log gap:** 6 of 9 room-days have `encounters:0` because the acoustic energy signal (`bench_level_sample`) shows `no_energy_evidence` for 21-22 Sep on every room checked, despite transcripts existing. This is a platform gap, not a matching failure — their recall is 0 by construction, not by acoustic-only missing a real signal. Affected: Cardiology OPD 2026-09-21, Cardiology OPD 2026-09-22, OPD 5 2026-09-21, OPD 3 2026-09-21, OPD 3 2026-09-22, OPD 6 2026-09-22.

## Overall

- PQM consults (truth): 55
- Hypotheses (fused): 7
- Recall (PQM consults with a matching hypothesis): 3/55 = 5.5%
- Precision (hypotheses matching a consult): 3/7 = 42.9%
- Splits (one PQM consult matched by >1 hypothesis): 0
- Merges (one hypothesis matched by >1 PQM consult): 0
- Start error (s): median 175.2, p90 369.6 (n=3 matched pairs)
- End error (s): median 327.6, p90 356.8 (n=3 matched pairs)

## Per room-day

| Room | Date | Truth | Hyp | Recall | Precision | Splits | Merges | Start err med/p90 (s) | End err med/p90 (s) |
|---|---|---|---|---|---|---|---|---|---|
| Cardiology OPD | 2026-09-23 | 3 | 3 | 0/3 (0.0%) | 0/3 (0.0%) | 0 | 0 | n/a (no matches) | n/a (no matches) |
| OPD 3 | 2026-09-23 | 8 | 2 | 2/8 (25.0%) | 2/2 (100.0%) | 0 | 0 | 139.0/175.2 | 233.0/356.8 |
| OPD 5 | 2026-09-23 | 3 | 2 | 1/3 (33.3%) | 1/2 (50.0%) | 0 | 0 | 369.6/369.6 | 327.6/327.6 |
| Cardiology OPD (energy gap) | 2026-09-21 | 3 | 0 | 0/3 (0.0%) | n/a | 0 | 0 | - | - |
| Cardiology OPD (energy gap) | 2026-09-22 | 7 | 0 | 0/7 (0.0%) | n/a | 0 | 0 | - | - |
| OPD 5 (energy gap) | 2026-09-21 | 4 | 0 | 0/4 (0.0%) | n/a | 0 | 0 | - | - |
| OPD 3 (energy gap) | 2026-09-21 | 6 | 0 | 0/6 (0.0%) | n/a | 0 | 0 | - | - |
| OPD 3 (energy gap) | 2026-09-22 | 13 | 0 | 0/13 (0.0%) | n/a | 0 | 0 | - | - |
| OPD 6 (energy gap) | 2026-09-22 | 8 | 0 | 0/8 (0.0%) | n/a | 0 | 0 | - | - |

## Notable: room-days with both truth and hypotheses present, zero matches

- **Cardiology OPD 2026-09-23**: 3 acoustic hypotheses and 3 PQM consults, but their time windows don't overlap at all (~-205.9 min gap between the two windows) — not a near-miss on the 50% threshold, a genuinely disjoint time range.

No transcript text or patient identifiers above; `token_uid`s and hypothesis ids are opaque.
