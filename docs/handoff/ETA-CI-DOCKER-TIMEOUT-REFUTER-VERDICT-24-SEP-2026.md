# ETA-Refuter — ci-docker-timeout: PASS at 15f6983, CONFIRMED at 74f4b81 (Fable ruling 18)

**Branch:** `vinay/ci-docker-timeout`. Reviewed twice: `15f6983` (PASS with findings), then
`74f4b81` (CONFIRMED — the head scribe should merge). Not on origin at time of writing; the push
awaits Fable.

Delivered on the bus as #111 (15f6983), #116 (74f4b81 confirm), #118 (gate ack).
This is the filed copy.

---

## Verdict: PASS at `74f4b81`. This head supersedes `15f6983`.

**Scope:** 2 commits on `a30186c`; 3 files, +88/−4 — `tests/support/pg-harness.ts`,
`tests/support/s1-pg.ts`, and the new `tests/unit/docker-available-timeout.test.ts`. Nothing else
moved.

## My explicit mandate: parity. It holds.

Ruling 18 named `tests/support/pg-harness.ts:22` specifically, because the first pass of this fix
missed that twin. The two `dockerAvailable` bodies are **byte-identical**, and those are the only
two definitions in the tree — no third twin was missed. Parity still byte-identical after the N3
edit at `74f4b81`.

## Four states proved directly, with a control

Throwaway worktree, fake `docker` binaries on `PATH`, **no daemon contact** — so no
Docker-on-the-Mini violation. Both implementations:

| state | returns | message | elapsed |
|---|---|---|---|
| working docker (**CONTROL**) | `true` | none | 4 / 20 ms |
| CLI absent (ENOENT) | `false` | `docker CLI not found` | 0 / 1 ms |
| daemon down (exit 1 + stderr) | `false` | `server unreachable: Cannot connect…` | 3 / 14 ms |
| socket hung | `false` | `did not answer within 15s` | 15004 / 15006 ms |

The ENOENT and stderr arms are the two herdr-kit explicitly said it had **not** exercised. The
control matters: without it, a probe that always returned `false` would read as a pass.

**A harness bug of my own, disclosed.** My first hang attempt returned in 89 ms. That was my
error, not theirs — I set `PATH` to only the fake directory, so `sleep` inside the fake was
unresolvable. `ok` and `down` had passed only because `echo` and `exit` are shell builtins. Fixed
with `/bin/sleep`. herdr-kit's own committed test already used an absolute path and avoided the
trap.

## N1 — the finding that mattered at `15f6983`, now closed

At `15f6983` the branch added **zero tests**, and no committed test observed the timeout or the
messages (all 21 importers use `dockerAvailable()` purely as a skip-gate).

Mutation **M1** — delete `timeout: 15_000` from both files — was **type-clean** and killed by **no
committed test**. Only my throwaway probe caught it. And M1 is worse than "slow": with the timeout
gone the hung probe ran the full **60155 / 60128 ms** and then returned **`true`** with no message.
A sick daemon is reported *available*, and the suite proceeds to use it.

`74f4b81` closes this with a committed 10-test file (5 cases × 2 impls) that includes a control
(`healthy daemon -> true`). Baseline 10/10, hung at 15011 / 15007 ms.

## N3 — the mislabel, now closed, and verified for collateral

N3 swaps `signal === "SIGTERM"` for `code === "ETIMEDOUT"`. That could have backfired: if Node did
not set `ETIMEDOUT`, the timeout message would silently vanish. Checked empirically on
**Node v26.7.0**:

| case | `code` | `signal` | old branch | new branch |
|---|---|---|---|---|
| real timeout | `ETIMEDOUT` | `SIGTERM` | fires | **fires** (label preserved) |
| SIGTERM from elsewhere | `undefined` | `SIGTERM` | **mislabels** | falls through correctly |
| missing binary | `ENOENT` | `null` | — | unaffected |

The new condition is strictly narrower than the old: it keeps every true positive and drops only
the false positive. A precision fix, no collateral.

## My mutations against `74f4b81` — both killed

| mutation | result | restore |
|---|---|---|
| **M1** delete `timeout: 15_000` from both | **KILLED** — 2 failed / 8 passed | `CLEAN: 0 dirty` |
| **M2** revert `ETIMEDOUT` → `SIGTERM` | **KILLED** — 2 failed / 8 passed | `CLEAN: 0 dirty` |

M2 re-run with test names to confirm it kills the **right** two — the two "dies of SIGTERM by
itself" tests, one per implementation, not collateral. A mutation that kills the wrong tests is not
a kill.

Gate pickup confirmed (`include: ["tests/unit/**/*.test.ts"]`).

## Gate

herdr-kit's box run on `74f4b81`: `RESULT ok, rc=0`; vitest **205 files / 4546 passed / 1 skipped**
(was 204 / 4536 at `15f6983`). The delta of **+1 file / +10 tests** matches exactly the count I
measured and ran myself. `check:silent` = 9, the same 9 as base `a30186c`.

**I did not rerun the full gate.** The heavy-run lock sends a full gate to the CI host, and the
branch is not on origin for the box to fetch. My verification is targeted: the new test file, both
mutations, the N3 semantics, parity, scope.

## Open / not fixed

- **N2 — Fable's call.** `sh()` at `pg-harness.ts:38` and `s1-pg.ts:105` still runs
  `docker run/exec/rm` with **no timeout**. D1's stated harm is therefore bounded only at the
  *probe*: a socket that hangs *after* the probe passed still stalls the gate to the 1800 s
  watchdog. `attest-method-testimony.test.ts:25` already bounds its own `docker run` at 120 s, so
  the pattern exists.
- **Nit, cosmetic, herdr-kit's call and deliberately deferred.** The SIGTERM test asserts only
  `.not.toContain(...)` against `String(err.mock.calls[0]?.[0])`. If nothing were logged, that
  becomes `String(undefined)` → `"undefined"` and the assertion passes **vacuously** — it cannot
  tell "logged the right thing" from "logged nothing". The same absent-vs-broken shape as the bug
  it guards. A positive assertion closes it.
- **Cost note, not an objection.** `dockerAvailable()` runs at module level in **20** test files,
  not once. vitest 2.1.9 defaults bound the worst case at roughly `ceil(20/workers) × 15 s` (~30 s)
  against the 1800 s watchdog.

## Stray — a production hazard, flagged

Local `vinay/s1-auto-drain` = `44e2e8a`: **1 ahead / 151 behind** origin (not 142). Its
`dockerAvailable` fix is **byte-identical** to `15f6983`'s in both files, so `git branch -D` loses
nothing. A normal push is rejected non-fast-forward; a **forced** push would roll production back
151 commits, because ruling 33 established that a push to that branch **is** a production deploy.

Pushing `vinay/ci-docker-timeout` itself is preview-only (non-`s1` refs build `target: null`,
18/18 in the window checked for ruling 33).

**The push and the delete are Fable's and V's call, not mine.** herdr-kit was right to hold on
scribe's request alone.

## Spun out of this review

The box CI gate does **not** run `check:silent` at all — filed separately as a fleet-wide finding
(bus #120, ledger 511). `yoga-ci-remote.sh` and `yoga-test.sh` have zero mentions of it, while the
repo `CLAUDE.md:18-21` names it as one of four non-Swift gate lines. Owned by eta-refuter-2 under
the L9 split; their fix spec (#121) improves on mine.
