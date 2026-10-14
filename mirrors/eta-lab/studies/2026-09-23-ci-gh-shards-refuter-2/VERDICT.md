# CI-GH-SHARDS — Refuter verdict (eta-refuter-2, 23 Sep 2026)

Under review: ETA `vinay/ci-gh-shards` @ 1ef205e (off d519d7b; adds only `.github/workflows/gate.yml`) and
eta-lab `kit/gh-gate.sh` @ 2314745. Order: `orders/CI-GH-SHARDS.md`. Builder: lx. Not built by this session.

**VERDICT: PASS-WITH-FIXES.** The gate can't go green by skipping, and a real failure turns it red. My own
mutant proved both. Two fixes are needed before it's trusted as a sole gate (F1, F2); two more are cheap
hardening (F3, F4).

## Runs I made (not quoted)
- **Mutant 15b0fdf** (NOT FOR MERGE; branch deleted), run 35884095123: **GATE FAIL, exit 1**, wall 3m43s.
  - M-a: flipped the `schema_migrations` row assertion INSIDE the Docker-gated 0118 suite. Shard 2 failed,
    annotated `tests/unit/e6-migration-0118.test.ts:71`. **This proves the Postgres suites execute on GitHub.**
  - M-b: turned one of the 9 accepted silent catches into a logged catch and added a NEW `.catch(() => {})` in
    the same route. Locally, check:silent still reports 9. **The typecheck job PASSED.** That is F2, proven.
- **Clean rerun d519d7b**, run 35884778798: **GATE PASS, exit 0**, wall 3m14s (slowest shard 4, 3m03s); lx measured 3m23s. The same commit passes clean and fails mutated, so the gate discriminates.

## Claims checked against the GitHub API
- Run 35873162972: head 691c6a0 on `ci/d519d7b3ce57`, all 12 jobs success. 691c6a0's parent is d519d7b, and the
  diff between them is gate.yml only (103 lines). Confirmed.
- Run 35873646055: conclusion failure; only `test (1)` and `gate` failed. `ci/8e6e70b07fb4` is gone from origin. Confirmed.

## Verified good
- Triggers: `ci/**` push and dispatch only. `permissions: contents: read`, no secrets. The dispatch `ref` input
  is used only in `with:`, never interpolated into `run:`, so it can't inject a script.
- **Skips can't pass green.** All 20 Docker-gated test files carry a "REQUIRED PROOF … ran, or was skipped
  deliberately" test that throws without Docker, and the workflow never sets `ETA_ALLOW_SKIP_E2E`.
- Git-dependent tests use only `git grep` / `ls-files` / `rev-parse`, which are safe at checkout depth 1. The
  vinay/* fetch was rightly removed in 1ef205e.
- The `gate` job has `needs: [all]` and `if: always()`, and requires every job to be `success`. A cancelled or
  skipped job therefore fails it.
- gh-gate: the synthetic commit is the target's tree plus the reference gate.yml only. A target that edits its
  own gate.yml is overridden. The run is matched by exact head SHA. Every error path exits non-zero, so it
  never reports a false PASS.
- Parity with the box gate: Node 22, `vitest@2.1.9 --no-save`, npm install with no lockfile. This is the same
  as `~/eta-ci` scripts.
- Public logs: dot reporter + `--silent`. Annotations carry assertion diffs of fixture values only.

## Findings
- **F1 (fix before sole-gate use): the attest proof is SKIPPED, not fixed.** `--exclude
  tests/unit/attest-method-testimony.test.ts` leaves a REQUIRED PROOF (0111's CHECK against real Postgres)
  permanently unrun on this path. The fix is one line in the test, and I verified it changes nothing:
  0109's blob is `adb3177…` at d519d7b, on production `vinay/s1-auto-drain`, and on
  `vinay/attest-capture` in `~/eta-ci/repo.git`. All three are identical. Replace the `git show` in `M0109()`
  with `readFileSync("db/migrations/0109_room_clinician_attestation.sql")` (ETA-Refuter's ledger lines
  453–454), then drop the `--exclude` and the CI-SKIP notice. Skipping was within lx's order, so this goes to
  whoever owns production tests (scribe), not against lx.
- **F2 (fix): check:silent accepts a COUNT, not the 9 findings.** gate.yml:50–52 passes any output with ≤ 9
  findings, so a new swallowed error that replaces a fixed one gets through. PROVEN by M-b above. Fix:
  commit the 9 as a baseline (file + trimmed line text, not line numbers) and fail on any finding outside it.
  (Aside, pre-existing and outside the contract: `SCAN_DIRS` lists both `components/recording` and
  `components`, so a finding under `components/recording` is counted twice.)
- **F3 (harden): the REST lookup doesn't filter by workflow.** gh-gate.sh:64 queries
  `actions/runs?branch=$BRANCH` across ALL workflows. The box has no `gh` login, so this is the path in use.
  If a target's tree ever carries a workflow that triggers on generic push, its run can be picked up and read
  as the gate's PASS. Latent today: ci.yml triggers on main and PRs, e2e.yml on dispatch only. Fix: query
  `actions/workflows/gate.yml/runs?branch=$BRANCH`.
- **F4 (harden): the synthetic commit is not deterministic.** `commit-tree` stamps the current time, so two
  panes gating the same SHA push different commits to the same `ci/<sha12>`. The second force-push, with
  `cancel-in-progress`, cancels the first run, and its caller gets a false GATE FAIL. It fails safe, but
  wastes a gate. Fix: export `GIT_AUTHOR_*`/`GIT_COMMITTER_*` name, email and date from the target commit, so
  identical inputs give an identical commit and the push is a no-op.
- Low: when the REST API is unreachable, `api_retry`'s `exit 3` runs inside `$(…)` and exits only the
  subshell. The script then exits 1 (the FAIL code) with no GATE line, which reads as a code failure. It is
  safe, but mislabelled.
- Low: `actions/checkout@v4` / `setup-node@v4` warn that Node 20 is deprecated, and `ubuntu-latest` moves to
  Ubuntu 26 on 19 Oct. Pin `ubuntu-24.04` so gate results stay comparable across that date.
- UNVERIFIED (as lx says): workflow_dispatch needs gate.yml on the default branch, and `main` is the stale
  7ffb168 (not production). Until then, `gh-gate.sh`'s push path is the only trigger.

## Addendum — 39503a7 (F1 re-check)
- The diff is exactly as claimed: `M0109()` reads `db/migrations/0109_room_clinician_attestation.sql` from the tree
  (the blob is adb3177, identical to vinay/attest-capture's). The `--exclude` and the CI-SKIP notice are
  removed from gate.yml.
- lx's run 35888783910: head 39503a7, gate.yml, success. Confirmed via the API.
- **My mutant 3c1557d** (flipped `method` to `"pin"` inside the Docker-gated 0111 suite, NOT FOR MERGE, branch
  deleted), run 35889502256: **GATE FAIL**. Only shard 6 failed, annotated
  `tests/unit/attest-method-testimony.test.ts:69 expected 'pin' to be 'pin_MUTANT_refuter2'`. The proof now
  RUNS against Postgres on GitHub. **F1 CLOSED.**
- Still open: F2 (the check:silent count-vs-set gap, proven), F3 (the REST lookup is not filtered by
  workflow), F4 (the commit-tree is not deterministic). The verdict stays PASS-WITH-FIXES until F2 lands.

## Addendum 2 — 8c708ec + gh-gate 5b2528e (F2–F4 re-check)
- **F2 CLOSED (proven on GitHub).** My swap mutant rebuilt on 8c708ec (bb7ed3a: one accepted catch now
  logs and a new `.catch(() => {})` is added, so the count stays 9), run 35894912700: **GATE FAIL**. typecheck
  annotated "NEW silent-failure handler (not in the accepted baseline): …finalize-text/route.ts
  await Promise.resolve().catch(() => …". A multiset keyed by path + trimmed text is the right design.
- **F3 CLOSED**: the REST lookup is now `actions/workflows/gate.yml/runs`.
- **F4 CLOSED (reproduced locally)**: built the synthetic commit for d519d7b twice, 2 s apart, and got
  06214cc both times. One residue: re-gating a sha whose `ci/` branch still exists pushes an identical ref,
  so no new run starts and the OLD result is returned. An infra flake then can't be retried without
  `--delete-branch` or deleting the ref. Document that, or add `--rerun`.
- **NEW G1 (HIGH until the branch lands): the GitHub gate now FALSELY FAILS every commit that doesn't
  contain 8c708ec.** gh-gate overlays only gate.yml, but the gate now depends on two more things that live
  in the target's tree: `.github/check-silent-baseline.txt` (absent at d519d7b AND on production
  `vinay/s1-auto-drain`) and the attest fix from 39503a7. Proven: clean d519d7b, run 35894950256, GATE FAIL
  (typecheck failed; shard 6 annotated attest-method-testimony.test.ts:41 "git show
  vinay/attest-capture … invalid object name"). Before it goes out on 8c708ec this gate PASSED the same commit
  (runs 35873162972, 35884778798). Every builder branch and tonight's train would get a false FAIL.
  **Fix:** land vinay/ci-gh-shards (the attest fix + the baseline) in the train BEFORE the GitHub gate is
  used on anything else. Meanwhile, gh-gate should overlay `.github/check-silent-baseline.txt` from
  GATE_WORKFLOW_REF along with gate.yml, and the gate should say "baseline missing" instead of failing with
  a traceback. Changes to the baseline in a builder's diff are reviewable: a Refuter must treat any
  ADDED baseline line as a finding.
- **Verdict now: PASS-WITH-FIXES, G1 open.** The gate is correct. It can't be trusted as a train gate until
  the branch is in the target.

## FINAL — PASS on vinay/ci-gh-shards @ 8c708ec (for train vinay/train-24sep, 24 Sep 00:07 IST)
Scope: the whole branch = 3 files on d519d7b: `.github/workflows/gate.yml`, `.github/check-silent-baseline.txt`,
and `tests/unit/attest-method-testimony.test.ts` (M0109 reads 0109 from the tree).
- The gate discriminates, proven on GitHub by my own runs: clean PASS (35884778798), a Postgres-suite mutant
  FAIL (35884095123), an attest mutant FAIL (35889502256), a check:silent count-preserving swap mutant FAIL
  (35894912700). lx's run on 8c708ec itself: head 8c708ec6ddf1, gate.yml, success (35894247044, via the API).
- **On the train:** trial-merged 8c708ec onto vinay/train-24sep @ 0a5d4b3: CLEAN, 3 files. On the merged
  tree, check:silent finds 9 and **0 new vs the baseline** (the train adds no silent catches). The attest suite
  ran against real postgres:16 on the box: **8/8 passed, vitest rc=0**. The merge was discarded.
- **Inert for production:** gate.yml triggers only on `ci/**` pushes and workflow_dispatch, so a push to
  s1-auto-drain starts nothing. `.github/` is not part of the Next build. The attest change is a proven
  no-op (blob adb3177 is identical).
- **G1 is RESOLVED BY landing this** (the baseline and the attest fix enter the target). Not blocking and
  outside this branch: gh-gate (eta-lab) should overlay the baseline for older targets; F4 residue (sticky
  result while a `ci/` branch exists); the realpath-guard nit is D2's, not this branch's.
