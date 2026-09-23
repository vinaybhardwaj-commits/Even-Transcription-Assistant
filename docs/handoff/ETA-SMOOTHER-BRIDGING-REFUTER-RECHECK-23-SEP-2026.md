# ETA — E-4 smoother, the bridging FAIL. REFUTER RE-CHECK. 23 Sep 2026

`vinay/encounter-clock` **@ `0a48bb6`** (builder split-speaker), one commit on `0dc2d4c`: `lib/encounter-clock/smooth.ts` (+28/−6) and its test (+52). Re-check of the FAIL in `ETA-SMOOTHER-BRIDGING-REFUTER-VERDICT-23-SEP-2026.md`. Own detached worktree `/tmp/refute-sm2`; builder's worktree never written to, nothing pushed.

## PASS — the defect is fixed, the fix is not over-tight, and the defect itself is now pinned

The fix is structural, as recommended: a break is judged **before** the state test, in one place, for all three rules. An open encounter closes; a `pending` run has no encounter to close, so it is discarded and the probe that broke it may start a new run.

### All five measured failures are gone — re-run with my own probes, not the builder's

| probe | at `2203873` | at `0a48bb6` |
|---|---|---|
| `S` + 20×`U` + `S` | one encounter, 21 hops | **nothing** |
| `S` + 1000×`U` + `S` | one encounter, **16.7 h** | **nothing** |
| two speech probes 600 hops apart, no probes between | one encounter, 10 h | **nothing** |
| `S` `D` `S` | opened across the dead mic | **nothing** |
| `S` `S` + tape-off between | opened across it | **nothing** |
| **control** `SS` + 20×`U` + `SS` | 2 | **2** |

### The fix is not over-tight — the half a re-check usually skips

A fix verified only against the failure it was written for is half-verified. `S` + 2×`U` + `S` still opens as **one** encounter spanning [0, 3]. That is the boundary case exactly: the bridge is measured between *judged* probes (`p.t - ps[lastJudged].t > bridge`), so two intervening unjudged probes are 3 hops = **180 000 ms**, which is not greater than the limit and therefore bridges. Legitimate short unjudged stretches still join, so the fix did not trade 16.7-hour encounters for fragmented ones.

**My own error, recorded:** I also ran `S` + 3×`U` + `S` asserting one encounter, calling it "exactly at the limit". It is not — that is 4 hops = 240 000 ms, one hop *past* the limit, and it correctly opens nothing. The probe was mis-specified; the code is right. The at-the-limit test is the 2×`U` case above.

### Mutation re-run — 14 mutations, **13 killed**, 0 runner errors

Six new mutations against the rewritten block, and **the defect itself is pinned**: restoring `state === "open"` on the break block (N1) dies, and leaving a broken `pending` run undiscarded (N2) dies. So do each of the three breaks read individually (N3 tape-off, N4 dead mic, N5 the bridge limit) and N6 — a subtle one worth naming: an open encounter must *close*, not merely discard, or its interval would be lost entirely. Five earlier mutations re-run as controls (the bridge constant, ending at last-speech rather than last-judged, the forced-close merge guard, the exit constant, tape-off-after-last-speech) all still die, so the rewrite weakened nothing.

**Two of the three former survivors are genuinely closed:** M12 (a hole counting as unjudged time) and M13 (`exitCount = 0` on speech) both die now.

### M14 — the builder's question answered with evidence: keep the field, narrow the claim

They asked whether `dead_mic_ms` should be removed rather than documented, on the ground that it is "structurally 0 under this ruling, because a dead mic ends the run". M14 still survives, which is **consistent with their own reasoning rather than a gap** — if the value is always 0, deleting the `+= hop` line changes nothing observable.

But the invariant is narrower than "under this ruling". It holds for a *single* encounter. It does not hold through `mergeTwo`, which re-tallies the whole span between two merged intervals — so a dead-mic probe sitting in the **gap** is counted. Measured:

- `seq("SSNDSS")` with **default** constants → `dead_mic_ms === 0`. Their claim holds. The gap between a `non_speech`-closed encounter and the next is exactly 3 hops and all three are the `N` probes that caused the close, so a `D` cannot fit.
- `seq("SSNDSS")` with **`{ exit: 1 }`** → **one merged encounter with `dead_mic_ms === 1 hop`.** The gap opens up and a `D` fits.

`EXIT_NON_SPEECH_PROBES` is exported, marked PROVISIONAL, and overridable through `opts.exit`, so this is a supported configuration, not a contrivance. **Recommendation: do not remove the field — it is not dead code. Change the assertion's wording from "structurally 0 under this ruling" to "0 at the default constants", and say why: the gap a `non_speech` close leaves is exactly filled by the probes that caused it.** If they want M14 dead rather than documented, the test that kills it is the `{ exit: 1 }` merged case above — but documenting is the better trade while the constants are provisional.

### Gate

- **Mine, on this commit:** 10 probes + 14 mutations = 24 runs through the Yoga fast runner, 0 runner errors, worktree verified clean at `0a48bb6` afterwards.
- **The builder's, quoted as theirs:** 33 smoother tests; Yoga 165 files, 3,725 passed, 1 skipped, typecheck + build, rc=0; `check:silent` the accepted 9, none in `lib/encounter-clock`.
- **Swift:** unreachable, verified independently — `git diff --name-only 248c2ae 0a48bb6 -- apps/` is empty.

## SCOPE — the blocker is not cleared until this is merged

`0a48bb6` is **not** an ancestor of `2203873`. `git merge-base --is-ancestor 0a48bb6 2203873` fails, and the branch listings confirm it: the fix exists only on `vinay/encounter-clock`, while the **defective code at `2203873` is what sits on `origin/vinay/s1-auto-drain`**, the branch production deploys from.

Nothing is broken today — the flag is off and the module has no caller. But the flag-on blocker from my verdict is **not** cleared by this commit existing; it is cleared when `0a48bb6` reaches the branch that carries `2203873`. Until then, the code on the deploy branch is still the code that produces a 16.7-hour encounter.

**Not run:** Jev. This is a re-check of a diff already scored, and the server's guidance is not to repeat an identical call; my probes and mutations are independent of it.

**Verdict: PASS.** The fix is correct, structurally right rather than three more guards, not over-tight at the boundary, and the defect is pinned so it cannot come back. One wording change recommended on M14, and one merge required before the blocker lifts.
