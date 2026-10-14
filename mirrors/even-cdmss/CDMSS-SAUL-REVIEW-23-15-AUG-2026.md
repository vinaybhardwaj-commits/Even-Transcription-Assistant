# Saul review 23

**Recorded 15 August 2026, verbatim, from V's transcript. Not edited.**

Governs: proof pass 1. It declines `bbff250` as completing proofs 11 and 12 and requires a forward
corrective commit after a narrow prospective signed v12.

---

**Findings**
1. **High:** Proofs 11 and 12 do not yet prove real SDK timeouts. `classifyLocalAttempt` checks `error.name` at `lib/transport-attribution-core.ts:137-141`, but the installed SDK's `APIConnectionTimeoutError` has:
   ```text
   name        Error
   constructor APIConnectionTimeoutError
   ```
   Both tests use a look-alike error whose `name` is manually changed, masking the production defect.
2. **Medium:** Test 11.3 scans unstripped source. Commenting out the two cloud success pushes would leave the test green.
3. **Low:** Test 12.7 hard-codes six strings rather than collecting the six executed outcomes. The individual rows are real, but the report overstates what 12.7 proves.
4. **Low:** Several source references still cite pre-pass line numbers.

**Pass 1 Verdict**
`bbff250` is not accepted as completing proofs 11 and 12.

Do not revert or amend it. Land a forward corrective commit after a narrow prospective signed v12. Pass 2 remains blocked until that correction passes the full gate.

Required pass 1a correction:

- Make `classifyLocalAttempt` recognize both declared `name` and `constructor.name`, fail-safely.
- Test with the actual exported `APIConnectionTimeoutError` from the installed `openai` package.
- Make proof 12's method mock throw that actual SDK error.
- Replace the closed-server terminal-failure case with a deterministic generic-error method mock.
- Add unconditional test cleanup for the loopback server and mocks.
- Strip comments before counting the two cloud success pushes and two local helper sites.
- Rename or rewrite 12.7 so it does not claim to aggregate executions it never reads.
- Correct stale source references.
- Use scratchpad copies for mutations; never `git checkout --` over uncommitted work.
- Run all nine gate commands plus keyed/unkeyed builds again.

After that corrective commit, proofs 11 and 12 may be accepted without rebuilding the remainder of `bbff250`.

**Finding 7.1**
Defer the precedence-resolver extraction.

`BATCH_OUTCOME_PRECEDENCE` is currently documentary vocabulary, but the six behaviors are directly executable. Extraction is not required by pass 2 or pass 3 and would unnecessarily edit ranking-adjacent code before byte-equivalence proofs.

It gets its own prospectively authorized refactor after the five proof passes.

**Pass 2 Scope**
Confirmed, after pass 1a:

```text
Proofs 2, 16, 17, 18, 70
J1, J2, J3, J4
```

Proof 35 remains in pass 3.

Pass 2 should be test-only. No production source change is presently required.

**Request Recorder**
Authorized.

Add an opt-in recorder to `lib/__tests__/judge-server-stub.ts` that captures:

- HTTP method.
- Request path.
- Exact entity-body bytes received by the loopback server.
- Acceptance sequence for concurrent requests.

Requirements:

- Preserve the existing parsed `requests` API.
- Never record headers or authorization values.
- Never write or log raw bodies.
- Bound request-body size.
- Return defensive snapshots.
- Refuse reset/snapshot while requests are in flight.
- Compare concurrent batches by stable marker identity, not arrival order.
- Preserve multiplicity.
- Reset observations without resetting responder configuration.

The J1 claim should be precisely:

> Byte-identical HTTP method, path, and entity-body bytes received by the loopback server.

It must not claim equality of TCP framing, TLS, or secret-bearing headers.

**Pass 2 Files**
Recommended contract:

- `lib/__tests__/judge-server-stub.ts`
- New `lib/__tests__/explicit-judge-equivalence.test.ts`
- New `lib/__tests__/rerank-pass-2.test.ts`
- New `lib/__tests__/explicit-judge-retrieve.test.ts`

Pass 2 must leave `rerank.ts`, `retrieve.ts`, `multi-query.ts`, `llm.ts`, `trace.ts`, capture, telemetry core/store, and settlement byte-identical to the corrected pass 1 base.

**Sequence**
1. Sign and track a narrow v12 authorizing the real-SDK timeout correction.
2. Land pass 1a as a forward commit.
3. Run the complete gate and issue a corrected pass 1 report.
4. Review and close proofs 11 and 12.
5. Issue the pass 2 kickoff with the recorder and exact test-only contract.
6. Begin pass 2 only after that review.

Current branch is clean and synchronized at `bbff250`; the report's "push held" line is stale because `origin/exp/rerank-telemetry` already points to that commit.
