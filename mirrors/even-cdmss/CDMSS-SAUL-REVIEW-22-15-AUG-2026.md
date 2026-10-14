# Saul review 22

**Recorded 15 August 2026, verbatim, from V's transcript. Not edited.**

Governs: the proof-pass programme. It declines the first pass 1 kickoff and requires a signed
prospective proof-pass addendum before any further production-code change.

---

**Decision**
Do not issue the current pass 1 kickoff. It is a good draft, but presently a no-go.

The corrective pass is closed at clean, synchronized `15d5e8f`. The remaining plan needs a prospective signed proof-pass addendum before further production-code changes.

**Pass 1 Changes**
Revise pass 1 to cover only proofs 11 and 12, plus the seed-status collapse.

Required amendments:

1. Remove proof 35 from pass 1.
2. Validate attempt outcomes in all three manifest locations:
   - Expansion attempts.
   - Rerank batch attempts.
   - Multi-query variant-generation attempts.
3. Add `TRANSPORT_ATTEMPT_OUTCOMES` as the runtime authority and retain `ManifestAttempt.outcome: string`.
4. Use a stable defect such as `attempt_outcome_absent_or_invalid`.
5. Make core authoritative for `RERANK_SEED_STATUSES`; capture re-exports the same object. Test identity with `strictEqual`, not only deep equality.
6. Authorize generated `lib/architecture/map.generated.ts`; the new core-to-transport import changes the architecture graph.
7. Prove timeout deterministically with a test-local method mock. Do not rely on an external host or wall-clock timeout.
8. Require the judge server to start before dynamically importing `rerank`, `multi-query`, `llm`, or transitive consumers.
9. Replace "every adjacent precedence pair coexists" with this executable matrix:
   - Timeout error gives `timeout`.
   - Generic exhausted transport gives `terminal_failure`.
   - Malformed completion gives `parse_failure`.
   - Missing plus nonnumeric keys gives `missing_score_key` while preserving both counts.
   - Finite plus nonnumeric keys gives `nonnumeric_score`.
   - All finite keys gives `success`.
10. Run the complete governing gate, including architecture, registry, governance, changelog, keyed/unkeyed build behavior, tests, typecheck, build, and diff checks.

**Proof 35**
Move proof 35 to pass 3, after the dispatch proofs.

Two telemetry corrections must be prospectively authorized first:

- A skipped/no-request stage records `attempts: []`, not `null`.
- A variant-generation stage that ran and failed without transport proof records `unattributed`; only a stage that did not run records stage-level `null`.

These are durable telemetry changes, although they do not affect ranking or provider behavior.

**Judge Requirements**
Adopt J1–J6 prospectively. Do not describe them as recovered verbatim.

- **J1:** Explicit judge and environment-default judge must produce byte-identical serialized results, canonical telemetry payloads, and outbound judge requests under deterministic collaborators. Cover success, real batch parse failure, and generic outer judge failure. No field differences are permitted.
- **J2:** Explicit judge invokes neither `checkHealthy` nor `cohereFn`, under judge or hostile Cohere defaults, on success or failure. This is call-local; an earlier memoized probe is irrelevant.
- **J3:** Execute `retrieve` under a hostile Cohere default. The omitted-backend control must demonstrate Cohere intent/downgrade; the explicit-judge arm must show zero Cohere consultation, judge intent, judge service, no downgrade, nonzero batches, and actual reordering.
- **J4:** `retrieveMultiQuery` keeps reranking off on every retrieval arm and performs exactly one fusion-level rerank with third argument `'judge'`. Expansion is independent and must not be claimed to "agree" on a rerank backend.
- **J5:** Assignment persists across retries. Deferred to the Treatment Protocol.
- **J6:** Assignment persists across redeployments. Deferred to the Treatment Protocol.

Use the real local judge server for J1/J3/J4 and injected call counters for J2.

**Revised Five Passes**
1. Pass 1: proofs 11 and 12, seed collapse, all-location attempt validation.
2. Pass 2: proofs 2, 16, 17, 18 and 70, plus J1–J4.
3. Pass 3: proofs 35, 45, 46, 47, 49 and 56, plus the two D16 payload corrections.
4. Pass 4: proofs 21–24, with a prospectively authorized default-preserving lifecycle fault-injection seam if execution requires it.
5. Pass 5: proofs 10, 14 and 44.

Proof 14 must land completely. `labRetrieve` is instrumented at current HEAD, including both catch arms. A partial proof cannot close Stage 0a.

**Governance**
Before pass 1:

1. Create a signed prospective proof-pass addendum.
2. Record the canonical J1–J6 contract.
3. Authorize the attempt validator and both D16 corrections.
4. Authorize the narrow lifecycle test seam in principle, with no production caller and no default-path consultation.
5. Record the revised five-pass grouping and complete gate.
6. Track the governing ruling rather than relying on missing review text.

**Final Sequence**
1. Sign and commit the proof-pass addendum.
2. Issue the revised pass 1 kickoff.
3. Gate and review each pass before starting the next.
4. Require 20/20 hard proofs and 4/4 executable judge proofs.
5. Sign a closing evidence ledger with test names, SHAs, and gate results.
6. Complete the replacement qualifying measurements and all five guardrails.
7. Verify the production HMAC key and database role.
8. V authorizes deployment.
9. Deploy first.
10. Run the migration route once, inspect `steps`, and stop on any 409 or non-`ok:true`.
11. Begin Stage 0b only after successful migration verification.

The current completion plan's "migrate, then authorize deploy" order is invalid because the migration route does not exist in production until deployment.
