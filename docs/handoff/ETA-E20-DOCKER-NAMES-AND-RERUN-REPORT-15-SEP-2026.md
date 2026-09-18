# ETA-E20 — unique Docker container names, and the rerun · REPORT · 15 Sep 2026 · Builder (`scribe3`)

**1. Container names: DONE — `c041ea8`** on `vinay/e20-losing-score` (parent `24e48aa`, worktree `-e20`). Committed, not pushed.
**2. Rerun of `-e20`'s Docker suites: NOT DONE — Docker is unhealthy.** Every call has answered HTTP 500 (`…/docker.sock/v1.55/version`) from 03:38 through 03:54 IST. I did not start or restart Docker. **The 22:25 results remain untrustworthy.**

## 1. The fix
**The mechanism was worse than a collision.** Both harnesses run `docker rm -f <name>` before `docker run --name <name>` (`tests/support/pg-harness.ts:28-29`, `tests/support/s1-pg.ts:99-100`). With fixed names, a suite starting in one worktree **deleted the database a suite in another worktree was running against**. The 22:06 plain run in `-e20` shows it: `eta-c2-e2e` already held a schema (`relation "bench_window" already exists`).

| file | + / − | change |
|---|---|---|
| `tests/support/container-name.ts` (new) | 40 / 0 | `containerName(base)` = `<base>-<sha256(realpath(git top level))[:10]>`; falls back to the working directory |
| `tests/support/pg-harness.ts` | 3 / 1 | `PG_NAME = containerName("eta-c2-e2e")` |
| `tests/support/s1-pg.ts` | 8 / 2 | `pgContainer(base)` names `containerName(base)` and returns `name` |
| `tests/unit/container-name.test.ts` (new) | 62 / 0 | 7 tests, no Docker needed |

- **Uniqueness:** different in every worktree or clone, so no pane can remove another pane's container.
- **Stability:** the same within one worktree, so each harness's own `rm -f` still clears a container its previous run left behind.
- **Different suites in one worktree** keep distinct names (`eta-c2-e2e-<tag>`, `eta-s1-emotion-<tag>`, …).
- **Still possible:** two concurrent runs of the *same* suite in the *same* worktree. One suite at a time per worktree remains the rule, and it is now the only place the rule is needed.
- **The sweep test** fails if any test file runs a named container without `containerName`, or holds a fixed `eta-` name. Today the only `--name` sites are the two harnesses.
- **Mutation check: 4 of 4 killed**, files restored by sha256:
  - **N1** tag ignores the worktree: 1 test;
  - **N2** `PG_NAME` back to the fixed name: 2;
  - **N3** `pgContainer` uses the base unchanged: 2;
  - **N4** tag from the working directory instead of git's top level: 1.

**Gate** (`-e20`, Docker unhealthy throughout):
- `typecheck` 0.
- `npm test` plain: 4 failed — **exactly the 4 REQUIRED PROOF sentinels, unrun, not green** (`c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored`, `s1-fix2-migrations`); 2577 passed, 100 skipped. With `ETA_ALLOW_SKIP_E2E=1`: 112 files, 2581 passed, 100 skipped.
- `build` 0. `check:silent` — the 9 pre-existing findings.
- `swift build` complete.
- `swift test`: **first failed with F5** (`plugin for module 'TestingMacros' not found`). I cleared **this worktree's** git-ignored `apps/room-recorder/.build` (476 MB) and rebuilt: `swift build` complete, **600 tests in 48 suites passed**. No other tree's build directory was touched.

## 2. The rerun — blocked, and exactly what to run
**Untrustworthy, from `-e20` on 14 Sep** (per the ruling): the Docker suites in the 22:06 plain run and the 22:2x `ETA_ALLOW_SKIP_E2E=1` run (2674 / 2674), **and** my ~22:3x plain re-run of `c2-e2e-runner` + `diarize-dispatch` + `e20-losing-score` (82 / 82). All used the fixed names while other panes could have been running the same suites.

**What stands without Docker:** E20's 16 unit tests and 11 of 11 mutations, and the live shadow control (13 matched, 0 disagreements). None of these touch a container.

**What waits for the rerun:** the 0096 migration proofs (applied twice; the refusals) in `c2-e2e-runner`, and the Docker halves of `s1-auto-drain` (E17's SQL tests), `s1-emotion-zero-scored` and `s1-fix2-migrations`.

**Rerun command** once `docker version` answers (now safe beside other panes, from `c041ea8`):
```
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-e20 && npx vitest run tests/unit/c2-e2e-runner.test.ts tests/unit/s1-auto-drain.test.ts tests/unit/s1-emotion-zero-scored.test.ts tests/unit/s1-fix2-migrations.test.ts
```
Run it **without** `ETA_ALLOW_SKIP_E2E`, so a skipped suite fails its REQUIRED PROOF sentinel instead of passing silently.

## Flags
1. **The fix protects `-e20` only until it reaches the other branches.** The main tree (`vinay/s1-auto-drain`) and `-e16` still use fixed names. They can no longer collide with `-e20`, but they can still collide **with each other**. Until `c041ea8`'s four files are carried to those branches, "one Docker suite at a time" still binds them.
2. **Docker's 500 is not diagnosed.** It is a daemon or API state outside this repo, and restarting it is not mine to do.
3. **F5 recurs.** `TestingMacros` broke in a worktree where `swift test` passed at 22:25, and a clean `.build` fixed it. The E21 note to clear `.build` applies to every worktree, not just the main tree.
