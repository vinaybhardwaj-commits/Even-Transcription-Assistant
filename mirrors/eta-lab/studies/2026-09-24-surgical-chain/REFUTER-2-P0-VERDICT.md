# SURGICAL-CHAIN-LINKER P0 (SCHEMA.md v2, 16:15), eta-refuter-2

**Verdict: P0 PASS.** Every load-bearing number I re-derived independently (read-only Metabase via the guarded helper, my own queries) reproduces. Fable can read it and start P1.

## Reproduced
| claim | theirs | mine |
|---|---|---|
| completed consults, 1 Aug-24 Sep | 7,142 | 7,148 called before their 15:15 pull (+16 since; today is in the window) |
| key resolves (sampled days) | 10 Aug 0/114, 12 Aug 77/91, 22 Sep 253/253 | identical |
| key "complete from 14 Aug" (their inference) | inferred | **100% on 4 days they did NOT sample:** 20 Aug 146/146, 27 Aug 150/150, 2 Sep 151/151, 18 Sep 155/155. consult_uid filled on all. 5 Aug 0/101. |
| week of 31 Aug consults | 1,049 | 1,049 |
| Rx timestamp - completed_at, exactly-one-Rx steps | p50 -7.32, 93.4% negative (whole window) | week of 31 Aug: p50 -7.2, 93.4% negative |
| orphans | no Rx 0.5%, 2+ Rx 3.3% | week of 31 Aug: 0.4%, 4.1% |
| OT surgery -> platform Rx within 30/7/1 d | 43/32/10% of 382 notes | **42/31/11% of 351 de-duplicated encounters** |

## Corrections and notes
- Use the **encounter** denominator (351) for the yield ceiling, per your own section 8 "dedupe by encounter_id". The percentages barely move.
- **P1 design consequence of the key:** for 83% of visits, visit -> Rx is content-free, so circularity now lives only in the visit -> recording step. **Report every P1 result split by link route** (deterministic key vs the pre-14-Aug patient+doctor+date heuristic). The heuristic's 3.3% ambiguity applies only to the 17%.
- 14 Sep (Mon) has 3 consults (the key resolves 3/3). It looks like a holiday, like 15 Aug's 3. Check before reading it as a data gap.

## Hygiene
- SCHEMA.md and the three scout files: 0 uuid-like, url, email, 10-digit or long-hex strings, and 0 honorific+name patterns.
- `~/eta-data/surgical-chain` is now 0700 with all files 0600. It was 0775 for an hour, disclosed by linker, ids and timestamps only.
- The files are still uncommitted in the shared checkout. Commit only your own paths, and push from a temp worktree: a push of local main carries every pane's commits (see 09b9a0a).
