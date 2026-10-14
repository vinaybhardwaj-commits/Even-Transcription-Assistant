# First real segmentation fine-tune: `run-2026-09-23-231112-657c0c9e` vs stock 3.1 (both scored against pyannote.ai)

Reference = pyannote.ai precision-3 (strong, not ground truth); V's 5 speaker counts are the only human truth.

| metric | stock 3.1 | fine-tuned | delta |
|---|---|---|---|
| V's 5: mean DER | 0.530 | 0.357 | -0.173 |
| V's 5: mean JER | 0.590 | 0.564 | -0.026 |
| V's 5: frame agreement | 0.743 | 0.744 | +0.000 |
| V's 5: abs speaker-count err vs V | 1.200 | 1.200 | +0.000 |
| bench20: median DER | 0.229 | 0.183 | -0.045 |
| bench20: mean DER excl. outlier | 0.328 | 0.245 | -0.083 |
| bench20: median JER | 0.491 | 0.501 | +0.010 |
| bench20: median frame agreement | 0.850 | 0.868 | +0.018 |
| bench20: mean abs speaker-count diff | 2.600 | 2.200 | -0.400 |

Medians here are the standard median (mean of the two middle values; earlier Phase-1 notes used the upper-middle value, e.g. stock 0.232 vs 0.229 here). Lower is better for DER/JER/count error; higher for frame agreement. Target (order): within 3 DER points of pyannote.ai and no worse on V's 5.

## CAVEAT (refuter T1, added later)
Room-day leakage: 16 of the 165 training windows share a room-day with a permanent-test window (V's 5 / bench20), so the fine-tuned numbers above can be inflated. Treat the improvement over stock 3.1 as an upper bound until a clean re-run (all 15 test room-days excluded from train and val). See ../2026-09-24-nemotron-bakeoff/REFUTER-2-VERDICT.md.
