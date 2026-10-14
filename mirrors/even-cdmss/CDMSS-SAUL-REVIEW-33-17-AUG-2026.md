**Verdict**
**HOLD administrative closure.** Technical proofs remain closed at **7/20 hard and 4/4 judge**, but one explicitly required repair did not reach the real path.

**Blocking Finding**
`5.2b-fail` demonstrates a separate cleanup implementation; it does not repair or guard actual test 5.2b.

Actual 5.2b:

- Waits at `explicit-judge-equivalence.test.ts:288`.
- On rejection, only calls `reqA.end()` at lines 290–292.
- Skips `await aDone` at line 293.
- Reaches `judge.settled()` in the outer `finally` at line 307.

Because recording was off at acceptance, recorder `inFlight` never counted this request. `judge.settled()` can therefore return while the HTTP request remains active.

The new 5.2b-fail test at lines 310–366 independently destroys and awaits another request. No shared helper connects that behavior to actual 5.2b. Its own `await aSettled` is also unbounded.

**Required Repair**
1. Extract one bounded cleanup helper used by both actual 5.2b and 5.2b-fail.
2. On `waitForContinue` rejection, destroy the request, boundedly await response/error termination, then rethrow the original wait error.
3. Make 5.2b-fail exercise that same helper, not duplicate its logic.
4. Add mutation row 35 that removes or defeats the shared cleanup and requires 5.2b-fail to fail by name without timing out.
5. Correct the test-file header that still calls v19 signed by V.
6. Rerun recorder rows 1–14 and 31–35, typecheck, tests, and the full gate.

**Sixteen Waits**
Do not require all sixteen to be rewritten in pass 2. Record them as test-harness debt. The report's statement that every one follows a completed request is false, especially shared `recorded()` cleanup, but broad conversion should be a separate bounded-settlement hardening task before the next mutation campaign that can leak recorder accounting.

**Accepted**
- V20/v21 signatures reconstruct correctly.
- Commit 9 and commit 10 path sets are valid.
- V21 correctly superseded the stale kickoff path count.
- The completed-step HEAD deviation is acceptable.
- Rows 33/34, tested-byte equality, six evidence digests, gate, final clean state, and six-local-commit topology pass.
- The `bodyFailed` cleanup behavior is ratified as necessary fail-loud handling.
- Supplemental-report stale wording is accepted as documentary errata and need not be rewritten.

Do not push or start pass 3. After the shared 5.2b cleanup is repaired and evidenced, pass 2 can close without revisiting the already closed proofs.
