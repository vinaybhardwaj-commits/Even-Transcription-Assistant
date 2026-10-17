# T28b fix round 2 report (cloud-t28b-harness)

Serving model: claude-sonnet-5-5 (Sonnet 5.5).
Branch: cloudpane/cloud-t28b-harness/fix2 (from fix1 2f331ff). Commit: recorded in OUTBOX.md at push.
Tests: 85 passed, 0 failed (`python3 -m pytest eval/pdqi9/t28b/tests -q`, synthetic only).

## Monday commands (repo root, run in order; commit or stash first so the tree is clean)
```
C="--manifest M.jsonl --vecs V.json --centroids CENT.json --truth TRUTH.jsonl --exclude TUNING149.txt --out-dir OUT --anchor ANCHOR --seed S"
python3 -m eval.pdqi9.t28b prereg $C --expect-exclude 149 --target-trials 100000 [--one-label-pass] [--doctor-floor 15] [--sim-reps 200]
python3 -m eval.pdqi9.t28b score  $C --armc-fire-rate R --consults-per-month N [--doctor-floor 15] [--sim-reps 200]
```
ANCHOR must be a path outside OUT (it is created by prereg and refused if it already exists). The last stdout line of prereg is the prereg.json sha256; copy it somewhere off the box too. score repeats the sim and floor flags and refuses if they differ.

## Conditions closed
- H1 `--expect-exclude N` required. prereg exits 2 unless the exclude file holds exactly N unique normalised uids and every one matches the manifest. `--exclude-unmatched-ok` is removed.
- H2 prereg.json holds `config`: doctor floor, sim reps, sim boot reps, target coverage, rho grid. score refuses on any difference ("MISMATCH config").
- H3 prereg prints the prereg.json sha256 (last stdout line) and writes it to `--anchor`. Anchor inside the out dir is refused. score requires `--anchor` and checks prereg.json against it, so rewriting prereg.json and prereg.sha256 inside the out dir no longer scores.
- H4 prereg records `tree` from `git status --porcelain` on eval/pdqi9/t28b. Dirty or git unavailable sets it. score prints DIRTY, and every would-be PASS reads "DIRTY, no PASS"; FAIL still shows.
- H5 When doctor_uid differs from logged_in_doctor_uid, the speaker's truth label is tested against the logged-in doctor's centroid with arm (c) (standard runner-up set). A fire counts in T28b-nd. The count of such consults prints at prereg and score (`covering_consults`).
- H6 Known over-count, left as is: a doctor split across two labels in one consult leaves the second label non-truth, so it is tested in T28b-nd against the doctor's centroid. It can only add false accepts, never hide one.

## INFERRED
- I1 `subprocess` is now imported in core.py only, for the single fixed `git status --porcelain` call (no shell). The import-ban test still bans network and DB modules everywhere and allows subprocess in core.py alone.
- I2 H5 trials use the standard runner-up set, so an enrolled speaker centroid that matches the label suppresses the fire (tested). A covering clinician with no centroid does not.
- I3 Dirty means any porcelain line under the package dir; ignored files (eval/.gitignore covers __pycache__) do not count.
