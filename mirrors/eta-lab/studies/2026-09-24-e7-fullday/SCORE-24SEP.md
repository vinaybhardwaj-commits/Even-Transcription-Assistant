# E-7 full-day score, 24 Sep 2026 (lx, ruling 213; committed per ruling 226)

Run: `e7-rescore.sh 2026-09-24`, 20:06-20:25 IST, eta-lab origin/main `a963b69`. All 5 stages passed, replay failed = 0.
Scoring rule: a consult matches when a hypothesis overlaps >= 50% of the shorter interval. Truth = PQM CONSULTATION
`called_at` / `completed_at` (Metabase db 13) for the 4 voiceprint-confirmed room-days. Counts, ids and times only.

## CAVEATS (read before using any number below)
1. **Most probes had no stored transcript, so the E-6 arms (acoustic, fused, fused-e61) were starved of text.** OPD 3: 406 of 579 probes
   had none (only 23 judged), and fusion confirmed 0 of its 4 acoustic encounters. Their 2/23 recall is a text gap, not a clean measure of the
   encounter clock.
2. **The ">= 50% transcribed" table is by WINDOW coverage, not probe text, and the two disagree.** 20 of 23 consults pass the window
   test, yet 40-70% of probes per room had no transcript. Window coverage against probe text is not yet reconciled, so the
   acoustic/fused recall in that table (2/20) probably overstates how much text those arms had. UNVERIFIED.
3. **Arm d is not a blind test.** It takes the doctor's working span (first call to last completion, +-10 min) from the queue, and truth is
   PQM. Parameters are the 23 Sep declared ones, unchanged and untuned, so this is an out-of-sample day, but not queue-independent.
4. **The confirmed-room set comes from stored voiceprints, which ruling 182 says fail on current audio.** OPD 1 is confirmed on only 31
   attributed turns and its doctor has no PQM rows on 24 Sep (queue = 0, arm d cut 0 clips there).
5. One day, 4 rooms, 23 consults. No placebo or shifted-time control was run on this score, so recall is a raw match count.
6. Arm d precision fell from 61% (23 Sep, 17/28) to 43% (19/44). Its 2 splits and 2 merges have not been looked at by a human.

## Headline
Arm d recall **18/23**, precision **19/44 (43%)**. Acoustic, fused and fused-e61 recall 2/23 (2/55, 2/19, 2/19).

## Probes and fusion per confirmed room-day
| Room | Probes | No transcript | Silent | Judged | Acoustic enc. | Fused enc. |
|---|---|---|---|---|---|---|
| OPD 1 | 648 | 265 | 214 | 159 | 21 | 9 |
| OPD 3 | 579 | 406 | 150 | 23 | 4 | 0 |
| OPD 5 | 658 | 408 | 129 | 117 | 14 | 6 |
| OPD 6 | 663 | 384 | 174 | 102 | 16 | 4 |

Jev: 1604 decision rows, 663770 input tokens, est. $0.028.

## Full score tables (from the run)
## All consults
| Arm | Hyp | Recall | Precision | Splits | Merges | Start err (s) | End err (s) |
|---|---|---|---|---|---|---|---|
| acoustic | 55 | 2/23 | 2/55 | 0 | 0 | median 272.1, p90 480.6 (n=2 matched pairs) | median 992.0, p90 1739.4 (n=2 matched pairs) |
| fused | 19 | 2/23 | 2/19 | 0 | 0 | median 272.1, p90 480.6 (n=2 matched pairs) | median 992.0, p90 1739.4 (n=2 matched pairs) |
| fused-e61 | 19 | 2/23 | 2/19 | 0 | 0 | median 272.1, p90 480.6 (n=2 matched pairs) | median 992.0, p90 1739.4 (n=2 matched pairs) |
| arm-d | 44 | 18/23 | 19/44 | 2 | 2 | median 157.5, p90 528.0 (n=18 matched pairs) | median 143.5, p90 796.0 (n=18 matched pairs) |

## Consults >= 50% transcribed (20 of 23; 3 with no transcript at all)
Read RECALL here; read PRECISION from the table above (an encounter matching an uncovered consult counts as unmatched here).
| Arm | Hyp | Recall | Precision | Splits | Merges | Start err (s) | End err (s) |
|---|---|---|---|---|---|---|---|
| acoustic | 55 | 2/20 | 2/55 | 0 | 0 | median 272.1, p90 480.6 (n=2 matched pairs) | median 992.0, p90 1739.4 (n=2 matched pairs) |
| fused | 19 | 2/20 | 2/19 | 0 | 0 | median 272.1, p90 480.6 (n=2 matched pairs) | median 992.0, p90 1739.4 (n=2 matched pairs) |
| fused-e61 | 19 | 2/20 | 2/19 | 0 | 0 | median 272.1, p90 480.6 (n=2 matched pairs) | median 992.0, p90 1739.4 (n=2 matched pairs) |
| arm-d | 44 | 18/20 | 19/44 | 2 | 2 | median 157.5, p90 528.0 (n=18 matched pairs) | median 143.5, p90 796.0 (n=18 matched pairs) |


---

## Addendum (24 Sep, 21:40 IST): run 2, and the E-6.2 proposal 1 (P1) test (ruling 226)

### Run 2 happened, unplanned
The 21:00 cron entry (set up by lx) checked only the hold file and lx had removed it, so a **second full rescore ran at 21:00-21:39** on the
same script and a fuller day (more diarized turns). The cron entry is removed. Jev cost of run 2: 1,684 decision rows, est. $0.029.
Run 2 wrote the same probe keys in `jev_decision` and new shadow runs, so the DB now holds run-2 values; the tables above are run 1.

| Arm (all 23 consults) | Run 1 | Run 2 |
|---|---|---|
| acoustic | 55 clips, 2/23, 2/55 | 59 clips, 2/23, 2/59 |
| fused / fused-e61 | 19 clips, 2/23, 2/19 | 20 clips, 2/23, 2/20 |
| arm d | 44 clips, 18/23, 19/44 | 44 clips, 18/23, 19/44 (identical: it reads the level log and queue, not text) |

Probes with no transcript, run 2: OPD 1 258/671, OPD 3 406/579, OPD 5 405/671, OPD 6 376/671; judged 171 / 22 / 120 / 108.
The extra transcript did not change the E-6 result.

### P1 result: NOT supported on 24 Sep
P1 = keep an acoustic encounter only if at least 50% of its judged probes are clinical (E6-2-PROPOSALS.md, proposal 1). Tested on run 2's
consistent data with the unchanged E-7 scorer. The current rule (>= 1 clinical probe) was re-derived first and reproduces the stored fusion
confirm counts exactly (10 / 0 / 6 / 4).

| Rule | Encounters kept | Recall | Precision |
|---|---|---|---|
| current: >= 1 clinical probe | 20 | 2/23 | 2/20 |
| P1: clinical share >= 50% | 10 | **0/23** | 0/10 |
| P1 strict: share > 50% | 9 | 0/23 | 0/9 |

- **Both real matches would be dropped.** The two encounters that match a consult have clinical shares of **0.20** (OPD 5: 3 of 15 judged) and **0.40**
  (OPD 6: 4 of 10 judged). On 23 Sep the three matches had 0.57-1.0. The clinical share of a true consult is not stable across days and rooms.
- What P1 keeps: high-share encounters that match nothing in PQM, e.g. OPD 5 share 0.71, OPD 6 share 1.00 (2 probes). OPD 1's 10 kept encounters
  cannot be scored, because its doctor has no PQM rows (precision 2/20 includes them; 2/10 without OPD 1).
- n = 2 matches, so this is a failure to reproduce the 23 Sep tie-cut, not a proof that P1 is wrong. **Recommendation: do not adopt P1.**
  The limit is text (most probes were never judged) and how U6 scores true consults, not the keep threshold.
- Approximation: clinical = U6 `clinical_consultation` with confidence >= 0.5, minus U1 `not_a_consultation` at >= 0.9 (fusion.ts `clinicalVerdict`);
  an encounter's probes are those whose start falls inside it. The replication check above validates this against the stored counts.
- Judged rows read (u6) exceeded the run-2 summary's judged counts by 4 / 1 / 1 / 0 per room (175 vs 171, 23 vs 22, 121 vs 120, 108 vs 108),
  most likely leftover run-1 rows. Effect on the result: none that could change it (the two matches are 15 and 10 judged probes).

### SQL used (verbatim, via `kit/neon-select.mjs`; column names checked on live rows, not only in migration 0116/0118)
```
SELECT subject_id, question_id, answer->>'choice' AS choice, confidence FROM jev_decision
WHERE subject_type='probe' AND question_id IN ('u1_phase','u6_kind') AND prompt_version IN ('u1-phase-w1','u6-kind-v2')
AND (subject_id LIKE 'pr_rd_abcwg2qf_%' OR subject_id LIKE 'pr_rd_6cn2jp2d_%' OR subject_id LIKE 'pr_rd_ed8endsg_%' OR subject_id LIKE 'pr_rd_ueankkjc_%')
```
Script: `p1_share.py <scratch_dir>` (reads `p1-rows2.json` = the query output, and `out-2026-09-24/`). Counts, ids and shares only; no text was read.
