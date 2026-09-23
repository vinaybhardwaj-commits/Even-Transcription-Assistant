# ETA — low_signal: the floor, X4 and X6. REFUTER RE-CHECK. 23 Sep 2026

`vinay/low-signal-marker` **@ `0c77d44`** (builder fleet), on `c8c05dc`. Re-check of the finding and two survivors in `ETA-LOW-SIGNAL-MARKER-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktree `/tmp/refute-ls2`, HEAD asserted. Production reads read-only, counts and percentiles only.

## PASS — 6 of 6 killed, and the calibration holds on 43% more data than it was derived from

| probe | result |
|---|---|
| **Z1** — the floor's value is pinned, not merely present | **killed** |
| **Z2** — my X4: it is `peak` that is compared, never `avg` | **killed** |
| **Z3** — my X6: `percentile` sorts before indexing | **killed** |
| **Z4** — *control*: no samples still means `null`, never `false` | **killed** |
| **Z5** — *control*: `percentile` returns `null` on empty, never 0 | **killed** |
| **Z6** — the value is p05 specifically, not a neighbouring percentile | **killed** |

### The floor is right, and I re-derived it rather than checking the number was copied

`QUIET_FLOOR_RMS` is now **0.008**, and the comment records that it is the measured p05 of `peak` over actively-recording spans **directly**, with no rounding or safety factor — which is the part that broke the original: the old 0.016 was `2 ×` a median, and doubling a median guarantees a floor above the median.

The useful check is not that the number matches what I supplied, but whether it still holds now:

| | when I derived it | now |
|---|---|---|
| actively-recording samples | 51,074 | **73,097** (+43%) |
| p05 of `peak` | 0.00800 | **0.00800** |
| share marked at the new floor | — | **3.46%** |
| share marked at the old floor | 74.1% | 72.2% |

**The p05 did not move across 22,000 additional samples**, so the calibration is a property of the distribution rather than an artefact of the window I happened to measure. That matters more than the fix itself: a floor derived from one sample and stable on a much larger one is a floor you can leave alone.

**Z6 is the probe worth naming.** Moving the floor to 0.0077 — the p01, one step away and visually almost identical — dies. So the tests pin *p05 specifically*, not "roughly the quiet end". Given the distribution is extremely tight at the bottom (p01 0.0077 to p25 0.0091, a 1.2× spread) while the marked share swings from 0.4% to 3.6% across it, pinning the exact percentile is the only thing that makes the calibration reproducible. fleet also aligned `deriveQuietFloor`'s own percentile to p05, so a future re-run reproduces this target rather than a different one.

### Both survivors closed, and X4 was the live one

- **X4** was live rather than latent when I raised it: `avg` had gone from 0% to 72.3% of rows that morning, so `(avg ?? peak)` would have changed the basis on most data. `low_signal: peak < floor` is now pinned.
- **X6** had no production caller, but `percentile` is the function `deriveQuietFloor` will be trusted with **exactly once** to set the replacement constant. An unsorted percentile would have produced a plausible-looking wrong number on a value nobody can eyeball. Now pinned.

## Gate

- **Mine:** 6 mutations locally, 0 errors, worktree asserted clean at `0c77d44`; production reads returned counts and percentiles only.
- **The builder's:** as recorded on the branch.

**Jev — not run.** The substance is a numeric constant measured against production; a scalar score on the diff cannot see the data it was derived from.

**Verdict: PASS.** The marker now fires on 3.46% of actively-recording audio instead of 74%, the value is pinned to the specific percentile that makes it reproducible, and both survivors are closed — including the one that had quietly become live while the review was in flight.
