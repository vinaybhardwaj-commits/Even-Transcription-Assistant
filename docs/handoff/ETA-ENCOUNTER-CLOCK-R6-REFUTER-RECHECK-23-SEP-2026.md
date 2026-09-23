# ETA — encounter clock, the three mutation gaps. REFUTER RE-CHECK. 23 Sep 2026

`vinay/encounter-clock` **`11de0b4` → `0dc2d4c`** (builder split-speaker), two commits: `5e1b5e2` (Fable's bridging ruling, smoother) and `0dc2d4c` (the three test gaps my 23 Sep mutation addendum found). Re-check of those three gaps only. Own detached worktree `/tmp/refute-clk6`; builder's worktree never written to, nothing pushed.

## PASS — all three closed, verified by my own mutations rather than the builder's replay

The builder reported replaying my three mutations. I did not take that: I re-applied **my own** mutation strings against `0dc2d4c`, added **two controls** (mutations that were killed at `11de0b4`, to prove the new tests did not weaken existing coverage) and **one new probe** the builder did not run.

**6 of 6 killed, 0 runner errors.**

| id | mutation | at `11de0b4` | at `0dc2d4c` |
|---|---|---|---|
| C6 | `ENERGY_ACTIVE_MIN = 0.05` → `0.5` | GREEN | **RED** |
| C5 | `basis === "avg" ? s.avg : s.peak` → `fin(s.avg) ? …` | GREEN | **RED** |
| C10 | drop the `\|\| a.idx - b.idx` tie-break | GREEN | **RED** |
| C7ctl | *control* — the `reached` cursor | RED | **RED** |
| C1ctl | *control* — quiet+text → `halves_disagree` | RED | **RED** |
| C6b | *new probe* — `0.05` → `0.01` (lowered, not raised) | — | **RED** |

The two controls matter as much as the three fixes: a test file can be rewritten in a way that closes one gap and opens another, and these say it was not. **C6b** is the probe the builder did not run — I mutated the threshold *downwards* as well as upwards, because a test that pins a constant in only the direction the reviewer happened to try is the same class of weakness as the original. It dies too, so the value is pinned in both directions.

### The tests say what they claim — read, not inferred from a red result

A mutation dying proves the test *fails*; it does not prove it fails for the right reason. All three read correctly:

1. **The threshold.** The fixture no longer derives its hot-frame count from the constant — hard-coded `mk(5)` active / `mk(4)` quiet — **and** `expect(ENERGY_ACTIVE_MIN).toBe(0.05)` asserts the value outright. Either alone would kill C6; both is right, because the hard-coded fixture pins the behaviour and the assertion pins the contract. The comment records why.
2. **Scale mixing.** Now asserts `median_dbfs` ≈ `dbfs(0.5)` and `active_frac === 1`, not just `level_basis` and `n`. Under the mutant the levels become `[0.5, 0.02, 0.02]`, so the median moves to `0.02` and the assertion fails — the numbers are checked, which was exactly the gap. Note `active_frac` does **not** discriminate here (0.02 and 0.5 are both above the 0.00398 floor, so it is 1 either way); `median_dbfs` is the assertion doing the work. Minor: `dbfs` is imported from the module under test, so a wrong `dbfs` formula would not be caught — but the discriminating fact is *which input the median came from*, which holds whatever `dbfs` computes, so the test is sound as written.
3. **The tie-break.** Maps one probe with two chunks sharing a `start_ms` in **both input orders** and requires identical `pieces`. Because `Array.prototype.sort` is stable, the un-tie-broken mutant returns `chunk_idx: 0` for one ordering and `7` for the other — so the test kills it on the second ordering, which is the only way this could have been tested.

### SCOPE — `0dc2d4c` sits on a commit I have not refuted

`5e1b5e2` landed between my r5 re-check and this one. Stating precisely what that does and does not affect:

- Its change to **`lib/encounter-clock/gate.ts` is comment only** — three lines recording Fable's "accepted as inert" ruling. I verified this from the diff. The gate's behaviour is unchanged, so my r5 verdict on the gate still stands as written.
- The **behaviour** change is `lib/encounter-clock/smooth.ts`, 75 lines: an encounter bridges `unjudged` time only to the merge window, while tape-off and a dead mic close it immediately. **I have not reviewed this.** My r5 verdict said in its first paragraph that the E-4 smoother was not in scope, and it still is not. The builder reports 24 smoother tests and five mutations verified dead; that is their own self-check and is not a verdict. **If Fable wants the bridging rule refuted before merge, it needs an order — I will not treat a peer's report as a review.**

### Finding 2 is now dispositioned by ruling, not open

The r5 verdict left Finding 2 "closed on safety, open on purpose": reading `peak` against an RMS floor makes every production probe `active`, so the pre-selector never skips. `5e1b5e2`'s comment records Fable's ruling — **accepted as inert for now**, because the level log only began at 19:53 on 22 Sep, so no full room-day has one yet. That is consistent with my own scope caveat (one room, one day) and it is a ruling, so the finding is settled rather than outstanding. The code stays and becomes meaningful on the first full day the recorder reports levels. The mutation work above is what makes that safe to defer: the threshold and the scale discipline are now pinned, so the half cannot drift while it waits.

### Gate

- **Mine, on this commit:** the two clock test files ran clean between every mutation and restored clean after each — six apply/run/revert cycles, 0 runner errors, worktree verified empty at `0dc2d4c` afterwards.
- **The builder's, quoted as theirs:** Yoga runner, 165 files, 3,716 passed, 1 skipped, typecheck + build, rc=0; `check:silent` on the Mini at the accepted 9, none in `lib/encounter-clock`. I did not re-run the full suite for a test-only change.
- **Swift: UNPROVEN, and unreachable by this diff.** The builder says so themselves and the repo's `CLAUDE.md` sanctions that reading for keychain-class failures over SSH. I verified the stronger point independently: `git diff --name-only 248c2ae 0dc2d4c -- apps/` is **empty** — the branch changes seven TypeScript files and no Swift file at all, so the `.lockFailed` / errno 35 / `.archiveKeyUnavailable` failures cannot be caused by it. The UNPROVEN Swift gate is not a risk this branch carries.

**Verdict: PASS** on the three gaps. All closed, both controls hold, the value is pinned in both directions, and the tests assert the right things. The open item is not a finding but a scope fact: the bridging change in `5e1b5e2` is unrefuted and needs an order if it is to be reviewed before merge.

**Not run:** Jev. This commit is test-only against a diff already scored, and the server's guidance is not to repeat an identical call.
