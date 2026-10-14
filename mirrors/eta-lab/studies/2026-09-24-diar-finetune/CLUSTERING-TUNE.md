| config | n | mean DER | median DER | median JER | abs count diff |
|---|---|---|---|---|---|
| ft_default | 8 | 0.274 | 0.203 | 0.475 | 1.25 |
| ft_t0.75 | 8 | 0.276 | 0.205 | 0.473 | 1.12 |
| ft_t0.65 | 8 | 0.326 | 0.185 | 0.524 | 1.75 |
| ft_t0.55 | 8 | 0.339 | 0.221 | 0.563 | 1.25 |
| ft_t0.85 | 8 | 0.373 | 0.349 | 0.590 | 1.25 |
| ft_t0.45 | 8 | 0.418 | 0.377 | 0.691 | 1.75 |
| stock_default | 8 | 2.890 | 0.225 | 0.608 | 1.50 |

## Clustering re-tune (phase-2 step 2) — held-out room-days only

Windows: 8 that the fine-tune never trained on (val room-day rd_yhh6kexm, 5 windows, plus the 3 test-split windows of dataset `diar-train-merged-2026-09-24-657c0c9e`). Reference = pyannote.ai teacher RTTM. Grid: fine-tuned segmentation (`best.ckpt` of run-2026-09-23-231112-657c0c9e) with min 2 / max 8 speakers and clustering threshold 0.45–0.85; `ft_default` = pipeline defaults (threshold ~0.70, no speaker bounds). V's 5 and the bench20 were not touched. n=8 is very small; treat differences of a few points as noise.

Findings:
- No tuned threshold beats the default in a meaningful way. Best mean DER: default 0.274 vs t=0.75 0.276 (a tie); t=0.65 has the best median (0.185) but a worse mean and worse JER. Thresholds at or below 0.55, and 0.85, are worse. The optimum is flat around the default, so the payoff of a threshold re-tune is roughly zero; recommendation: keep the default clustering and drop min/max bounds from the ship config unless V wants them for policy.
- The real gain is in the tail: stock 3.1 has two held-out windows with DER 3.76 and 17.89 (mean 2.89, driven by those); the fine-tuned model's worst window is 0.68. Median DER 0.225 → 0.203.
- Next by payoff order: more teacher labels (every 2-3 days) and repeat the segmentation fine-tune; embedding fine-tune only if the count error (1.25 speakers/window vs teacher) stays after that.
