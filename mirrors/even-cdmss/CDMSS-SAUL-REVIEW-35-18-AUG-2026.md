**Decisions**
- Cohere will be evaluated on operational value, not clinical-score superiority.
- V ratifies the orchestrator's delegated authority for pass 3.
- No Cohere flip or golden clinical A/B is authorized.

**Plan**
1. Freeze current pass-3 work long enough to reconcile governance.
2. Preserve and review the existing uncommitted changes in:
   - `lib/retrieval-capture.ts`
   - `lib/__tests__/retrieval-telemetry-core.test.ts`
3. Supersede v23 with an internally consistent addendum that:
   - Records V's explicit delegation ratification.
   - Removes the obsolete digest and personal-signature steps.
   - Retains the exact pass-3 scope, stop conditions, two commits, and no-push rule.
   - States whether existing in-scope work is covered by the original prospective delegation.
4. Align the kickoff with the corrected addendum before work resumes.
5. Audit the current diff against the authorized two payload corrections and proof 35.
6. Confirm whether the required intermediate `typecheck` and test run occurred before proof work. If no reliable record exists, replay the sequence in an isolated clean worktree without discarding the current diff.
7. Resume proofs 35, 45, 46, 47, 49, and 56, followed by mutations, commit 13, the single full gate, evidence, and commit 14.
8. Do not push until Saul reviews and releases the pass.

**Cohere Workstream**
- Keep the judge backend unchanged during evaluation.
- Replace the golden clinical A/B with a preregistered operational benchmark covering:
  - Latency distribution and throughput.
  - Cost per request/candidate.
  - Failure, timeout, fallback, and rate-limit rates.
  - Quota and capacity headroom.
  - Vendor concentration and failover value.
  - Data-handling and operational-complexity costs.
- Establish decision thresholds before collecting comparison data.
- Use identical archived inputs where needed to isolate backend performance, but do not interpret the benchmark as evidence of clinical ranking equivalence.
- Continue telemetry independently because intended backend, served backend, downgrade, and failure visibility remain valuable.

**Treatment Protocol**
- Keep it as a reviewed draft until implementation is imminent.
- Revise assignment derivation to use a canonical identity protected by domain-separated, versioned HMAC.
- Pin experiment/version, allocation algorithm, ratio, threshold, and key version.
- Define the assignment unit with the eventual rollout/canary design, not in the generic store.
- Add atomic concurrency handling, immutable conflict detection, execution linkage, a real retry test, and a genuine cross-deployment test.
- Require a signed implementation addendum after those details are settled.

Correction to my earlier progress note: the current dirty state does not prove kickoff preflight failed; it confirms only that pass-3 work began after the previously observed clean state. No files were changed during this planning review.
