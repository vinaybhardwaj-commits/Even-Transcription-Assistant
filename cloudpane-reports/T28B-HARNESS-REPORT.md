# T28b harness report (cloud-t28b-harness)

Serving model: claude-sonnet-5-5 (Sonnet 5.5).
Branch: cloudpane/cloud-t28b-harness/build
Commit: 80678d4 (OUTBOX-only follow-up commit may sit on top)
Tests: 27 passed, 0 failed (`python3 -m pytest eval/pdqi9/t28b/tests -q`, synthetic only). Smoke run: 600 synthetic consults, 30 doctors, 5,000 trials, 1.4 s with coverage sim.

## Layout
`eval/pdqi9/t28b/`: `core.py` (arm c, truth, sampler, prereg, scoring), `stats.py` (Clopper-Pearson, cluster BCa, coverage sim), `run.py` (CLI, S2c readout, C8), `tests/test_t28b.py`. Deps: numpy, stdlib only. Import-ban test covers http, requests, socket, DB clients, subprocess.

## Monday command (from repo root)
```
python3 -m eval.pdqi9.t28b --manifest MANIFEST.jsonl --vecs VECS.json --centroids CENTROIDS.json \
  --exclude TUNING149.txt --out-dir OUTDIR --seed SEED --target-trials 100000 \
  --armc-fire-rate RATE --consults-per-month N
```
Optional: `--truth truth.jsonl` ({consult_uid, label}; replaces arm (c) derivation), `--min-trials 2736`, `--boot-reps 10000`, `--sim-reps 200` (0 disables). Exit 2 on too few trials or a disjointness violation.
Manifest rows: consult_uid, doctor_uid (true speaker), logged_in_doctor_uid, optional vectors_path (else --vecs).

## Outputs (OUTDIR, all 0600)
`prereg_trials.jsonl`, `prereg.json` (seed, sha256, counts), `prereg.sha256` written BEFORE scoring; scoring re-checks the sha. `trials_scored.jsonl` (per-trial audit, has uids). `summary.json` (counts and rates only). Stdout: counts only.

## INFERRED, no record-only source in repo (please confirm against merge_c / armc-fa)
- I1 margin_next_label = cos(L,C) minus best cos(L',C) over other labels in the consult. margin_runner_up_centroid = cos(L,C) minus best cos(L,C') over other centroids. A missing other label or centroid counts as +inf (passes).
- I2 Thresholds compared with 1e-6 tolerance so float32 centroids exactly on 0.65 / 0.05 are not lost.
- I3 Trial label = the truth label; the impostor pool excludes doctor_uid and logged_in_doctor_uid. LOO removes both from the runner-up set.
- I4 Truth by derivation requires exactly one label passing arm (c) for the logged-in centroid against all centroids; otherwise no trials (counted as "no truth label").
- I5 Sampler: numpy default_rng(seed) choice without replacement over all (consult, impostor) pairs, sorted. If the universe is smaller than the target, all pairs are used.
- I6 If any clustering is degenerate (0 FA) its bound is the exact one-sided 97.5%; "larger" = max over the two clusterings. Underpowered still reports the bootstrap bound plus the flag.
- I7 Coverage sim: p fixed at 0.005, K and n/cluster from the data, beta-binomial ICC rho in {0, 0.01, 0.05, 0.10}. Reporting only, never gates.

## Findings
- F1 Exact bounds verified: 0/1,843 upper 0.19996%; 3/2,736 point 0.110%, CI 0.023-0.320%; 3/4,381 upper 0.19999%.
- F2 In the smoke run the coverage sim shows BCa under-covering at p=0.5% with strong overdispersion (0.97, 0.92, 0.87, 0.84 for rho 0 to 0.10). Report only; it is a property of BCa with rare events, not a bug found by the tests. The BCa unit test uses p=5%, where coverage is ≥0.90.
- F3 Not run: anything against real data. No Node/Swift gate applies (Python-only addition).
