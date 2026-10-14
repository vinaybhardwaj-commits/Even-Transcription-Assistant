# Ruling 103: count-matched VAL split (b642fdd2, 80bcf16 + 90f1084), eta-refuter-2

## Verdict
- The split MECHANICS PASS.
- The TARGET does not: val is matched to the test set's (bench20) count histogram, which is unrepresentative of production. **Fable's call**, because ruling 103 ordered "match the test count distribution". Recommendation below.

## Reproduced from the committed manifest (sha256 b3c62b77abbc1509…)
1. 0 windows on the 15 permanent-test room-days. The manifest's excluded list is the same set as `permanent-test-room-days.json`.
2. Train/val room-day overlap 0 (8 train, 4 val). Audio sha shared train/val: 0. The header lists match the windows.
3. Histograms reproduce diar-lab's table exactly:
   - train (<=8 speakers): 18/38/23/17/13/3, mean 2.83, plus 4 windows with >8;
   - val: 3/6/9/7/6/7, mean 3.84.
4. An independent exhaustive search (2-5 room-days, 20-40 windows, L1 to bench20) returns the SAME val set.
   - It is a 2-way tie at the best L1, resolved by the pre-stated lexicographic rule. Deterministic, fine.
5. Selection uses teacher val counts only; V5 is logged, not used for selection. I did not re-read the trainer for this item; it was covered in my variant review.

## The target problem
| share of windows by speaker count | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| bench20 (test) | 0.00 | 0.17 | 0.28 | 0.17 | 0.06 | 0.33 |
| production (327 labelled, 09cca5e) | 0.16 | 0.26 | 0.21 | 0.16 | 0.12 | 0.09 |

- The premise "VAL is biased low" compared val with **bench20, not production**. The old val's mean (~2.6) was close to production's (3.26); **bench20 is the outlier**, with 3.6x production's share of 6+ speaker windows and none with 1 speaker.
- Stopping on a bench-shaped val rewards whatever wins on bench20: over-counting relative to real rooms. It also leaks test information into selection.
- Against the production histogram the same search finds a much closer, unique fit: **L1 0.117** vs 0.397, n 40, mean 3.10.

**Recommendation:**
- Match val to the production histogram. Variant B already uses it as its balance target, so the two would be consistent.
- Report bench20 twice: raw, and re-weighted to production's count shares. Then a count gain that exists only on 6+ windows shows as such.

Open, not resolved: 2 of the 4 val rooms also appear in train (on other days). The manifest has no room ids for the test windows, so I cannot say whether test shares rooms with train the same way.
