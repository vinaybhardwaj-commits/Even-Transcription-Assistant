**Pass 2 Verdict**
The six substantive proof repairs are now technically sound, but the supplemental package is not yet closure-ready because the recorder contract and documentation still have narrow defects.

**Remaining Blockers**
1. Recording state is sampled twice.
   - Acceptance uses `recording` at `judge-server-stub.ts:333-348`.
   - Completion checks its current value again at lines 359-369.
   - Toggling during a request can create observations with `seq: -1`, lose accepted observations, or leak in-flight accounting.

2. Non-enumerable observation fields remain invisible.
   - `snapshot()` clones with object spread at `judge-server-stub.ts:473-477`, which drops non-enumerable properties.
   - Therefore `Reflect.ownKeys(judge.snapshot()[0])` cannot detect a non-enumerable stored authorization field.
   - Mutation row 29 adds an enumerable symbol, so it does not cover this case.

3. Test 5.4 can still hang indefinitely.
   - `explicit-judge-equivalence.test.ts:226-243` has no request error rejection and polls without a timeout.
   - Release cleanup does not cover failure before the acceptance wait resolves.

4. Supplemental evidence quotes only proofs 2, 16, 18, and 70.
   - Proof 17 is missing at `CDMSS-PROOF-PASS-2-SUPPLEMENTAL-REPORT-FOR-SAUL-16-AUG-2026.md:32-45`.
   - Proof 17 remains closed; this is documentary noncompliance.

5. Proof 70's comments still say review 28's comparison is undefined and declined.
   - `rerank-pass-2.test.ts:580-588` conflicts with v18's resolution.

6. The gate evidence overstates timestamp completeness.
   - Command 7 lacks timestamps and the refusal build lacks an ending timestamp.
   - The ordered log is still sufficient; no gate rerun is required solely for this wording.

**Proof Rulings**
| Proof | Recommendation |
|---|---|
| 2 | Close |
| 16 | Close |
| 18 | Close |
| 70 | Technically close; correct contradictory comments |
| J1 | Close |
| J2 | Close |
| 17, J3, J4 | Remain closed |

Administrative pass-2 completion should remain on hold until the recorder and documentary corrections land.

**Governance Rulings**
- Approve the no-`git add` command 6 replacement.
- Ratify the governance-only ungated-tip exception.
- Treat `finaliseTelemetry` → `writeRetrievalTerminals` as a naming-only erratum.
- Because another correction is already required, carry that erratum in v19 now rather than waiting for pass 3.
- Do not push `fe59b07` or `76307f0` yet; local HEAD is two commits ahead of upstream.

**Final Repair Plan**
1. Issue and sign v19 authorizing a narrow recorder/comment repair.
2. Capture `const recordThisRequest = recording` at acceptance and use it consistently through data, end, close, and observation creation.
3. Clone snapshots with own-property descriptors so symbol and non-enumerable fields survive inspection; defensively copy the body buffer.
4. Add mid-flight off→on and on→off recorder tests.
5. Add a non-enumerable authorization-field mutation and a parsed-request hidden-field mutation.
6. Replace unbounded acceptance polling with a bounded fail-loud helper, request error rejection, and outer-finally release. Apply it to 5.6 as well.
7. Correct proof 70 comments and the socket-ID/sequence analogy.
8. Run typecheck, tests, the expanded mutation table, commit, then the full gate.
9. Add a governance-only supplemental commit containing proof 17's verbatim quotation, the v18 symbol erratum, and corrected timestamp wording.

**Cohere Roadmap**
Do not choose A or B yet. Reject C, and authorize the golden A/B and Treatment Protocol design work immediately.

The roadmap needs these factual corrections:

- The live production backend value has not been independently verified; repository history is not a current platform attestation.
- The D16 corrections are specified and prospectively authorized in addendum v11; they are unimplemented, not undesigned.
- A prior four-arm/100-pair Cohere comparison exists. What is missing is a preregistered clinical release A/B with acceptance thresholds.
- `changelog:coverage` only checks that an engine version appears somewhere; it does not enforce `scoring:true`, treatment description, or clinical approval.
- The referenced D4 hold is ambiguous and must be restated in the switch authorization.
- The freeze claim and the full "29 nights" calculation are not fully supported by the current worktree.
- Downgrade is console-visible but lacks durable invocation evidence. Monitoring must also include `rerank_soft_failed`, not only `rerank_backend_downgraded`.

Option B should become eligible only after:

1. Stage 0a closes, including the proof-11 retrospective sweep.
2. Telemetry deploys, migrates successfully, and passes Stage 0b plus all qualifying guardrails.
3. J5/J6 and the Cohere Treatment Protocol are complete.
4. A blinded, preregistered clinical A/B passes explicit omission, relevance, score/band, subgroup, latency, cost, quota, downgrade, and soft-failure thresholds.
5. Provider credentials, model access, quotas, and budget are verified.
6. One treatment release contains the engine bump, semantic scoring changelog, and canonical `RERANK_BACKEND=cohere`.
7. The new switch SHA receives its own post-switch canary proving Cohere intent and service across rerank-eligible rows.
8. Rollback uses canonical `RERANK_BACKEND=judge`, a new engine declaration, and preregistered automatic thresholds.
9. Migration has a quiet-window procedure and partial-migration recovery plan.

No files were changed and no tests were run during this read-only review.
