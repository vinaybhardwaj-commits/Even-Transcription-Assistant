# T28b fix round 3 report (cloud-t28b-harness)

Serving model: claude-sonnet-5-5 (Sonnet 5.5).
Branch: cloudpane/cloud-t28b-harness/fix3 (from fix2 73fbd68). Commit: recorded in OUTBOX.md at push.
Tests: 104 passed, 0 failed (`python3 -m pytest eval/pdqi9/t28b/tests -q`, ~30 s, synthetic only).
Smoke (1,800 consults, 30 doctors, 6,000 trials, 200 sims x 3 rho): census, prereg and score ran; score took 30 s.

## Monday commands (repo root; commit first so the tree is clean)
```
K="--manifest M.jsonl --vecs V.json --centroids CENT.json --truth TRUTH.jsonl --exclude TUNING149.txt"
python3 -m eval.pdqi9.t28b census $K --expect-exclude 149 [--one-label-pass] [--doctor-floor 15]     # exit 3 = "K below floor"
python3 -m eval.pdqi9.t28b prereg $K --expect-exclude 149 --out-dir OUT --anchor ANCHOR --seed S --target-trials 100000 [--one-label-pass] [--sim-reps 200]
python3 -m eval.pdqi9.t28b score  $K --out-dir OUT --anchor ANCHOR --seed S --armc-fire-rate R --consults-per-month N [--sim-reps 200]
```
score refuses if --seed, --sim-reps, --doctor-floor or --target-coverage differ from prereg. Copy the hash prereg prints last.

## Rulings applied
- P1 Gating bound = beta-binomial profile-likelihood upper bound, method `betabinom_profile_v1`: ML over (p, rho), rho in [0, 0.5] (grid of 0 plus 60 geometric points 1e-6..0.5), largest p within chi2(1, 0.95)/2 = 1.9207 of the maximum. Zero events use the same profile (p_hat = 0). BCa and bootstrap-t stay as reported-only columns, plus exact CP.
- P2 Floor 15 doctors with >= 50 trials each. The coverage sim runs the profile bound at the data's K and trials per doctor (smallest gating clustering), p = 0.5%, rho 0.01 / 0.05 / 0.10, target 0.90. Below target or not run blocks PASS ("COVERAGE below target, no PASS"). The floor-raising search is gone.
- P3 prereg records `method` and `seed`. score refuses a different seed or method (tested, including a re-anchored edit).
- P4 `census`: distinct true-speaker doctors, doctors with >= 50 truth-labelled consults, consults and potential T28b trials (min / median / max / total). Counts only. Exit 3 and "K below floor" when fewer than the floor qualify.
- P5 Tests added: zero-event profile bound (checked against an independent math.lgamma likelihood), recovery of p = 0.11% at K = 20 and 30, coverage >= 0.94 at K = 15 / rho 0.10 / 2,000 trials per doctor (measured 0.99 at 300 sims), seed mismatch, census.

## INFERRED
- I1 Not-run coverage (--sim-reps 0) also blocks PASS. P2 only names below-target; I treated "unverified" the same way.
- I2 `--sim-boot-reps` is gone (the profile bound needs no bootstrap reps). The frozen config is floor, sim reps, sim p, target coverage, rho grid.
- I3 Census potential trials = consults x enrolled centroids that are not the doctor or logged-in doctor, before sampling.
- I4 Census eligibility counts truth-labelled consults that survive exclusion, vectors and the one-label rule; scoring eligibility is >= 50 trials per cluster.
- I5 The profile uses a rho grid (not a continuous optimiser); grid spacing 1.26x, effect on the bound is well under 1%.

## Findings
- F1 (decision needed) With zero events the profile bound is far above 0.5% because rho may reach 0.5, where the data cannot rule out all events sitting in a few doctors: K 15 x 2,000 trials 1.56%; K 20 x 150 0.17..1.7%; K 30 x 1,000 0.85%; smoke K 30 x 200 1.09% (LOO) and 1.37% (nd). The edge is binding (`rho_at_upper` = 0.5). Reaching 0.5% with no events needs roughly sum(ln n_i) >= 384, e.g. 50 doctors x 2,000 trials. So a clean zero-FA result will read FAIL on the headline at realistic Monday sizes. Exact CP for the same data is 0.06% to 0.2%.
- F2 With events spread across doctors the bound is informative: 3 events in 3 of 20 doctors x 137 trials gives 0.32%. With p = 0.11% and rho 0.002 the median bound is 0.20% at K 20 and 30; at rho 0.01 the median is 0.40-0.67% and the 90th percentile 0.8-2.2%.
- F3 The recovery test uses rho 0 and 0.002. At rho 0.05 (p_i nearly all 0, a few near 1) the median p_hat is 0.03% and the median bound 1.7-2.2%, so that setting is not a usable recovery scenario.
- F4 Coverage at the rho grid is conservative (0.96-0.99), because the bound is wide when rho is free.
- F5 Not run: real data, the Node/Swift gate (Python-only change).
