# REFUTER round 2 — 135d33e (vinay/vad-starvation). VERDICT: PASS

## Scope (coordinator item 3) — clean
`git diff --stat $(git merge-base fable-premerge-vad 135d33e)..135d33e` = exactly 9 files:
the 7 lib files + the 2 test files. `merge-base` is cdb6f67, NOT bbaba3b — vinay/vad-starvation
branched before the Jev Arm D and MEX merges, which is why a diff against the tag shows spurious
deletions. The fix commit alone (8d6b6e8..135d33e) touches 7 files, all on the allowed list.
`git ls-files | grep router_server` => NONE TRACKED; router_server.py is not in this repo and was
not touched. Branch pointers verified identical before and after my worktree work:
vinay/s1-auto-drain bbaba3b, vinay/vad-starvation 135d33e, fable-premerge-vad bbaba3b.

## Coordinator item 1 — the test count is branch content, not flakiness

| tree | unit test files | Tests line |
|---|---|---|
| repo @ bbaba3b (my round-1 run) | 137 | 3132 passed, 1 skipped |
| wt-pre @ 8d6b6e8 (pre-fix control) | 134 | 3076 passed, 1 failed, 1 skipped = 3078 |
| wt-fix @ 135d33e | 134 | 3078 passed, 1 failed, 1 skipped = 3080 |

Present in bbaba3b and absent from the vad branch: jev-arm, jev-client,
jev-migrations-0106-0107, jev-role, jev-window-job (5 files). Present on the vad branch only:
the 2 new files. Nothing is silently skipped — 134 files collected and 134 run in both worktrees,
and the one `skipped` is the same single test in every run including round 1.
**+2 is real**: 3078 -> 3080, same machine, same harness, same hour, one file changed between them.
The builder's 3079/3077 are these same numbers with the flake counted as a pass.

### The one failure, and why it is not this change
`tests/unit/e31b-atomicity.test.ts > E31 D3 > R58 — THE LIMITER STILL THROTTLES ...`
=> `the 1/sec gate counts rows the clinician failure never touched: expected 'ok' to be 'rate_limited'`.
A wall-clock 1-per-second rate limiter: it fires 12 wrong pins and needs them inside one second.
It took 8991 ms in my failing run vs 6353 ms in the passing repo run. It fails **identically on
wt-pre (8d6b6e8), the pre-fix control**, and it passed on the repo at bbaba3b in round 1 and in the
builder's own worktree. Timing-sensitive, environment-dependent, unrelated to all 9 files.
So: the environment IS mildly flaky, in exactly one wall-clock test — and that is a different thing
from the 3132/3077 gap, which is entirely branch content.

My first attempt used `git archive` + a symlinked node_modules instead of a worktree; that produced
10 failures, every one a repo-sweep/meta test (`no bare 300000 literal anywhere in the source`,
`no test file in the tree hard-codes a person`, `containerName is git's resolved top level`).
Those were artifacts of a non-git tree with node_modules symlinked in, and are discarded. All
numbers above come from real `git worktree add --detach` checkouts.

## Coordinator item 2 — mutation, not reading

One tree, one mutation at a time, reverted between, running only the two test files.
Control (unmutated 135d33e): 2 files, 21 tests, all green.

| mutant | result |
|---|---|
| M1 — F1 reverted: adapter reads top-level `outcome` again | **3 RED**, incl. the dedicated F1 regression: `expected 'no_engine' to be 'engine_text'` |
| M2 — F2 reverted: `silent_window` drops the `!== null` guard | **1 RED**: `expected false to be true` |
| M3 — admin.ts `engines` ternary inverted | **1 RED**: `expected 'ran' to be 'skipped'` |
| M4 — admin.ts `windows_*` forced to null | **1 RED**: `expected null to be 5` |
| M5 — F7 reverted (`\|\| asr.routerOutcome` restored) | **GREEN both ways — no test covers F7** |
| M6 — `buildRouteOutcome` ignores the carrier's `outcome` | **8 RED**, incl. both job-path tests |
| M7 — `buildRouteOutcome` reads `seg.outcome` instead | 2 RED (fixtures that omit `segmentation`) |

M1 and M2 are the ones that mattered: both named regressions genuinely go red when the fix is
undone, which is precisely what round 1's tests failed to do.

## The builder's residual-risk claim — checked, and it holds

`buildRouteOutcome` does still read `router.outcome` at the top of its own `RouterOutcomeInput`.
That is safe because **there is exactly one producer of `routerOutcome` in the whole tree**:
`toSttResult` in lib/stt/adapters/route.ts:105 (grep across lib/, app/, services/ returns that one
construction site; route-transcribe.ts:170 and room-drain.ts:1111 are consumers). Since F1 now
populates that carrier's `outcome` from `segmentation.outcome`, the level the carrier uses is an
internal convention, not a reading of the router's wire shape. M6 proves the whole chain is pinned:
break the last link and 8 tests, including both end-to-end job-path tests, go red.

Two things keep it from being ideal, neither blocking:
- `route-metrics-truth.test.ts` fixtures now carry `outcome` at BOTH levels, so that file alone can
  no longer tell which level is read (M7 reddens only its two segmentation-less fixtures). The
  discrimination lives entirely in vad-starvation-job-path.test.ts, which goes through the adapter.
- `buildRouteOutcome` has no `?? seg.outcome` fallback, so a second producer of `routerOutcome`
  added later would silently reintroduce F1 at that layer with no test to catch it.

## Other non-blocking residue
- lib/stt/adapters/route.ts:106 — `status: (r as Record<string, unknown>).status` is still a cast
  past the type, while `segmentation` beside it now uses the real `isRouterSegmentation` guard.
  `RouterResult` (lib/stt/eta-router.ts:16-27) still declares no `status`. Behaviourally correct —
  the router does send `status` at the top level — but it is the same shape as the bug just fixed.
- F7's fix (room-drain.ts:1110) is correct by inspection and untested (M5). Its blast radius is one
  metrics key on route runs with no timeline.
- route-transcribe.ts still computes `windows_total`/`windows_skipped` in `metrics` at line 166 and
  does not carry them into `doneWith`. Raised in round 1, not in the fix list, still true. The room
  drain does not use this job kind, so partial starvation still reaches the corpus via roomWindowPoll.
