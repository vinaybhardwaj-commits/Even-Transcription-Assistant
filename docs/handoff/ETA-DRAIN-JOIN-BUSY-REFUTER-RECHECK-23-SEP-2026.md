# ETA — drain-join-busy, the negative tests. REFUTER RE-CHECK. 23 Sep 2026

`vinay/drain-join-busy` **@ `5301fd7`** (builder yoga-drain), one commit on `1fa844c`: tests only, 71 lines added to `c1b-room-window-job.test.ts`. Worktree `/tmp/refute-djb2`, HEAD asserted, clean after. Baseline **80/80** (was 76).

## PASS — both survivors die, and the original property still dies too

| mutation | at `1fa844c` | at `5301fd7` |
|---|---|---|
| **D2** the match loosened to `String(join.error).includes("already_running")` | survived | **killed** |
| **D6** `join_timeout` added to the busy set | survived | **killed, 2** |
| **D1** the order's own control — busy no longer retried at all | killed, 3 | **killed, 4** |

D1 is the one worth re-running rather than assuming: tests added to pin an exclusion can quietly relax the inclusion they sit beside. It still dies, and harder than before, so both halves of the binary are now pinned.

**The tests are better than what I asked for.** I asked for one case: a non-busy error fails immediately. What was written is three:

- a **parameterised** control over each non-busy error code, so the property is asserted per-code rather than for one representative;
- `join_timeout` *"not folded into the busy set **even after two real busy answers**"* — a mixed sequence, which is the case a single-error test cannot reach and the one a real refactor would actually break;
- a string that merely **contains** `already_running` is not retried — exact match, not substring, which is D2 stated as a property rather than as my mutation.

The second is the one I would not have specified. A loosened match only misbehaves once a genuine busy answer has already put the loop in flight; testing `join_timeout` from a standing start would pass against a broken implementation.

## Verdict: PASS
The finding is closed. Nothing else on this branch changed — tests only, so the throughput fix reviewed at `1fa844c` stands as verified there.
