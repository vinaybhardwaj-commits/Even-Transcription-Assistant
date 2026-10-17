# T28b fix round 1 report (cloud-t28b-harness)

Serving model: claude-sonnet-5-5 (Sonnet 5.5).
Branch: cloudpane/cloud-t28b-harness/fix1 (from build 86b9968). Commit: recorded in OUTBOX.md at push.
Tests: 62 passed, 0 failed (`python3 -m pytest eval/pdqi9/t28b/tests -q`, synthetic only). Smoke: 2,400 consults, 30 doctors, 20,000 trials, prereg + score 3.8 s with the coverage sim.

## Monday commands (repo root, run in order; the out dir is 0700 and shared)
```
C="--manifest M.jsonl --vecs V.json --centroids CENT.json --truth TRUTH.jsonl --exclude TUNING149.txt --out-dir OUT --seed S"
python3 -m eval.pdqi9.t28b prereg $C --target-trials 100000 [--one-label-pass] [--exclude-unmatched-ok]
python3 -m eval.pdqi9.t28b score  $C --armc-fire-rate R --consults-per-month N [--doctor-floor 15] [--sim-reps 200]
```
Truth rows: {consult_uid, label, source}, source in role_votes_3of3 | manual. Exit 2 on any input problem.

## Rulings applied
- R1 `--truth` and `--exclude` required (argparse exit 2). No voiceprint truth anywhere. Bad source rejects the run. Summary has truth counts by source, `no_truth`, `truth_label_not_in_vectors`.
- R2 T28b-nd: every non-truth label vs the logged-in doctor's centroid, all such trials scored (not sampled). Headline and C8 use the worse of the T28b-LOO and T28b-nd bounds.
- R3 uids stripped of BOM and whitespace, lowercased, on manifest, vectors keys, centroids, exclude, truth. Unmatched exclusions exit 2 unless `--exclude-unmatched-ok`; the count is in prereg.json. Duplicate manifest, centroid or truth rows exit 2. Disjointness runs on normalised uids.
- R4 Fewer eligible clusters (>=50 trials) than the floor, or one cluster: UNDERPOWERED, no bootstrap bound, no PASS, exact CP bound printed as info. C8 not computed.
- R5 `stats.choose_floor`: sim at the data K, the configured floor and +5 steps, rho 0.01/0.05/0.10, coverage target 0.90. Chosen floor or "floor unattainable" and the table go to summary.json.
- R6 `prereg` writes sha256 of manifest, each vectors file, centroids (file incl. enrolment metadata), truth, exclude, both trial lists, thresholds, seed, code sha and git HEAD. `score` refuses on any mismatch, a re-run of prereg, or a missing prereg.
- R7 NaN, inf, zero-norm or wrong-dimension vectors exit 2 with a count. Out dir 0700, wider existing dir refused. `main` prints only the exception type for unexpected errors; our own errors carry counts only.
- R8 One-label consults abstain by default; with `--one-label-pass` they are scored. Count reported either way.

## INFERRED (confirm)
- I1 R8 abstain = the one-label consult is left out of every trial set (it cannot fire, so counting it would dilute the rate).
- I2 R2 "two bounds" = T28b-LOO and T28b-nd. T28b standard keeps its own point gate. I added a T28b-nd point gate at the same 0.2%.
- I3 T28b-nd has no LOO variant (the tested centroid is the true one). Clusterings for nd: true-speaker doctor and centroid doctor (logged-in).
- I4 Git commit = repo HEAD read from .git (no subprocess); `code_sha256` over the package's .py files is the path-specific identity.
- I5 Coverage sim p fixed at 0.5% (the gate), n/cluster from the data, K bound = max eligible clusters across the six clusterings; each clustering is judged against the chosen floor alone.

## Findings
- F1 In the smoke run the floor came out "unattainable": BCa coverage at p=0.5% was 0.66-0.94 for rho 0.01-0.10 at K 15-30, so every test reads UNDERPOWERED. Expect this on real data unless K is large or n per doctor is high; the exact CP bounds are printed instead. Your call whether the sim p or the 0.90 target should change.
- F2 nd trials are few per doctor (about one per consult), so nd clusters rarely reach 50 trials.
- F3 Not run: real data, the Node/Swift gate (Python-only change).
