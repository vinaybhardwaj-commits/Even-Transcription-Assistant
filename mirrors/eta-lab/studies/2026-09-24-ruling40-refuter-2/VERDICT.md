# Ruling 40: box runner check:silent (herdr-kit, isolated path ~/eta-ci-r40), eta-refuter-2

Runner v6 `in/runner.master.sh` sha256 90db89f3c51f32bb; gate `in/check-silent-gate.py` 38947ea0ffb0ac11; patch RULING40.patch against ea0fb13. Reference baseline = origin/vinay/s1-auto-drain @5970852, 9 accepted lines.

**Verdict: the RUNNER half PASSES on the isolated path.** It is NOT ready for the shared masters until C1 and C2 are met.

## My runs (my own output dir; herdr-kit's evidence files untouched)
| case | ref | result |
|---|---|---|
| CONTROL | 5970852 | 9 found, 0 new; hook run `RESULT test_hook_stop`; **hook OFF: `RESULT ok [tsc,tsc-tests,check-silent,vitest]`, 205 files / 4546 tests passed, NOT RUN: build, check-number-words, swift build/test listed** |
| KILL (theirs: new empty catch + the target's own baseline widened) | r40-kill | `runner_error:check_silent_new_finding` rc 9, the new line named. The target's widened baseline was ignored (my case 5). |
| KILL (MINE: a different handler form, `.catch(() => {})` added to lib/chunk-store.ts on 5970852) | r2-kill (deleted after) | rc 9, named. **Hook OFF: fails at check:silent, before vitest.** |
| FIXED | r40-fixed | 8 found, 0 new, plus a notice naming the gone accepted line. Not a failure. |
| ABSENT (empty arg) | control | `runner_error:check_silent_reference_baseline_missing` rc 9, distinct from a new finding |
| UNREADABLE (mine: the baseline file exists, mode 000) | control | same distinct fault, `Permission denied` named |

The gate script's 12 unit tests pass. It fails closed on:
- a count mismatch;
- rc 0 with no OK line;
- a directory as the baseline;
- an empty baseline (every accepted finding becomes new).

The test hook never prints `RESULT ok`.

## Conditions before the shared masters
- **C1:** prove the yoga-test.sh half through an isolation knob. Run CONTROL and ABSENT via yoga-test.sh itself, including the real fetch of the reference baseline from origin/vinay/s1-auto-drain and the shipping of the gate script. That is the path every real caller uses, and it has only passed `bash -n`.
- **C2:** in FULL mode, a target whose package.json lacks the check:silent script must be a runner fault (`check_silent_script_missing`), not a bracketed "NOT RUN" under `RESULT ok`. Every production-line commit since June has the script. A quiet "NOT RUN" is exactly the "RESULT ok != full gate" defect this ruling exists to remove.

## Recommended, not conditions
- `.github/workflows/gate.yml` still carries its own diff. For "one implementation" to be true it should call kit/check-silent-gate.py (scribe, ETA repo).
- A new finding is reported as exit 9 `runner_error:check_silent_*`. That is consistent with the typecheck precedent, but it is a CODE verdict, not a runner fault. Callers must not auto-retry any `runner_error:check_silent_new_finding`. Say so in the exit-code contract comment.
- The nm-cache is shared on a MISS (keyed by package.json hash). Acceptable.
