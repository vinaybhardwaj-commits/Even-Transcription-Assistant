# E-7 score — source=acoustic (encounter-clock-smooth-v1)

Match rule: interval overlap >= 50% of the shorter interval (orders/E7-PQM-TRUTH.md rule 2). Scored against `e7-truth.csv` (voiceprint-confirmed room-days only).

**Energy-log gap:** 6 of 9 room-days have `encounters:0` because the acoustic energy signal (`bench_level_sample`) shows `no_energy_evidence` for 21-22 Sep on every room checked, despite transcripts existing. This is a platform gap, not a matching failure — their recall is 0 by construction, not by acoustic-only missing a real signal. Affected: Cardiology OPD 2026-09-21, Cardiology OPD 2026-09-22, OPD 5 2026-09-21, OPD 3 2026-09-21, OPD 3 2026-09-22, OPD 6 2026-09-22.

## Overall

- PQM consults (truth): 55
- Hypotheses (acoustic): 13
- Recall (PQM consults with a matching hypothesis): 3/55 = 5.5%
- Precision (hypotheses matching a consult): 4/13 = 30.8%
- Splits (one PQM consult matched by >1 hypothesis): 1
- Merges (one hypothesis matched by >1 PQM consult): 0
- Start error (s): median 175.2, p90 369.6 (n=3 matched pairs)
- End error (s): median 327.6, p90 356.8 (n=3 matched pairs)

## Per room-day

| Room | Date | Truth | Hyp | Recall | Precision | Splits | Merges | Start err med/p90 (s) | End err med/p90 (s) |
|---|---|---|---|---|---|---|---|---|---|
| Cardiology OPD (energy gap) | 2026-09-21 | 3 | 0 | 0/3 (0.0%) | n/a | 0 | 0 | - | - |
| Cardiology OPD (energy gap) | 2026-09-22 | 7 | 0 | 0/7 (0.0%) | n/a | 0 | 0 | - | - |
| Cardiology OPD | 2026-09-23 | 3 | 4 | 0/3 (0.0%) | 0/4 (0.0%) | 0 | 0 | n/a (no matches) | n/a (no matches) |
| OPD 5 (energy gap) | 2026-09-21 | 4 | 0 | 0/4 (0.0%) | n/a | 0 | 0 | - | - |
| OPD 5 | 2026-09-23 | 3 | 5 | 1/3 (33.3%) | 1/5 (20.0%) | 0 | 0 | 369.6/369.6 | 327.6/327.6 |
| OPD 3 (energy gap) | 2026-09-21 | 6 | 0 | 0/6 (0.0%) | n/a | 0 | 0 | - | - |
| OPD 3 (energy gap) | 2026-09-22 | 13 | 0 | 0/13 (0.0%) | n/a | 0 | 0 | - | - |
| OPD 3 | 2026-09-23 | 8 | 4 | 2/8 (25.0%) | 3/4 (75.0%) | 1 | 0 | 139.0/175.2 | 233.0/356.8 |
| OPD 6 (energy gap) | 2026-09-22 | 8 | 0 | 0/8 (0.0%) | n/a | 0 | 0 | - | - |

## Notable: room-days with both truth and hypotheses present, zero matches

- **Cardiology OPD 2026-09-23**: 4 acoustic hypotheses and 3 PQM consults, but their time windows don't overlap at all (~26.8 min gap between the two windows) — not a near-miss on the 50% threshold, a genuinely disjoint time range.

No transcript text or patient identifiers above; `token_uid`s and hypothesis ids are opaque.

## Findings (follow-up, 23 Sep)

1. **Energy gap = logging had not started, not data loss.** `scribe_room_levels` returns `sample_count:0` (zero rows, checked directly, not inferred) for Cardiology, OPD 3, OPD 5, and OPD 6 on 21 Sep and on 22 Sep. All four rooms' first-ever level sample lands the morning of 23 Sep (Cardiology's first row: 2026-09-23 09:01:44 IST). A clean all-rooms zero before one shared cutover day is the shape of a rollout that hadn't reached these room-days yet, not deletion — loss would more likely leave partial-day gaps, not a uniform pre-cutover blank across every room.
2. **No clock/timezone offset.** Hypothesis `start_ms`/`end_ms` are raw epoch ms (unambiguous instants, no timezone to misread); `1790137298450` converts to exactly `2026-09-23 09:51:38 IST`, matching the intended local time. The ~27 min gap between the acoustic window and the PQM window is not a round-number offset (30 min/1h/5.5h), which rules out a systematic tz bug as the cause.
3. **Voiceprint turns say the doctor was in Cardiology ~10:21-10:29 IST, not 12:24-13:42 IST.** All 30 turns matched to the Cardiology OPD clinician that day cluster in a single 8-minute span inside the acoustic hypothesis window, roughly 2 hours before the PQM call times. Answer to "voiceprint turns in Cardiology at the PQM times": **no**. Two independent room-side signals (acoustic energy, voiceprint) agree with each other on a late-morning window and disagree with PQM's early-afternoon `called_at`/`completed_at` — the discrepancy looks more likely to sit on the PQM side (or a doctor_uid/room mapping issue) than in the room recording pipeline, but that's not verified here.
