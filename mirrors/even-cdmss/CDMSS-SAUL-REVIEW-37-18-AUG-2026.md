**Pass 3 Repair Review**
**Disposition: partial closure, STOP, no push.**

| Proof | Ruling | Reason |
|---|---|---|
| 35 | **Close** | Exact three-batch judge boundaries and the single Cohere boundary are now discriminated. |
| 45 | **Hold** | The claimed exhaustive D17 coverage remains false and malformed input can still throw. |
| 47 | **Hold** | The source pin does not execute the production caller handoff. |
| 56 | **Hold** | The PostgreSQL round trip is real, but teardown does not guarantee that the instance is disposable. |

Hard proofs are now **10/20**. Judge proofs remain **4/4**.

**Blocking Findings**
1. Proof 45 remains incomplete.
   - `candidate_start` has no independent invalid/absent test; both boundary rows mutate only `candidate_end` at `retrieval-telemetry-validation.test.ts:204-205`.
   - Missing `hmac_key_version` validates clean when the HMAC-absent licence is active at `retrieval-telemetry-core.ts:665-668`.
   - `batches: [null]` can throw instead of returning stable defect codes at `retrieval-telemetry-core.ts:759-771`.
   - The report's "54/54" and "20/20" coverage claims must be withdrawn.

2. Proof 47 still lacks execution through the caller.
   - Test 47.5 executes `assembleAuditContext` and then calls a test helper directly.
   - Test 47.6 only scans source at `retrieval-telemetry-validation.test.ts:490-512`.
   - The production wiring at `lib/opd-note-audit.ts:1600-1612` appears correct, but proof 47 requires executable evidence.

3. Proof 56's substance is correct, but lifecycle safety is incomplete.
   - It performs a genuine loopback PostgreSQL JSONB round trip.
   - `pg_ctl stop` failures are swallowed and the directory is deleted regardless at `retrieval-telemetry-canonicalization.test.ts:107-113`.
   - Subprocesses have no timeout, and failed startup can bypass reliable teardown.
   - This does not establish the authorized requirement that the instance is disposable.

**Disclosure Rulings**
- Section 3.1: the source pin is insufficient. An executable seam is required.
- Section 3.2: dependence on local PostgreSQL binaries is acceptable because missing binaries fail loudly. CI execution is not required before push, but teardown must be reliable.
- Section 3.3: variant-generation token validation is accepted as a real known defect and should be included in the next repair.
- Section 3.4: sandbox working-directory execution and nine mutation rows are accepted.
- The counting errors are disclosed, but future documents must use corrected counts.
- The rejected v24 artifact exists outside the worktree at `Even-CDMSS/REJECTED-CDMSS-RERANK-TELEMETRY-ADDENDUM-v24-18-AUG-2026.md`; current worktree checks pass.

**Authorized Next Repair**
A prospective v26 may authorize forward-only changes to:

- `lib/retrieval-telemetry-core.ts`
- `lib/opd-note-audit.ts`
- The three pass-3 proof test files

The scope is limited to:

1. Complete D17 validation from an explicit field/null/type matrix, including malformed array members and stable non-throwing validation of `unknown`.
2. Add separate discrimination for `candidate_start`.
3. Validate the HMAC-absent licence's fields as present and correctly typed.
4. Validate variant-generation usage fields.
5. Add a narrow default-preserving executable seam so real `assembleAuditContext` output runs through the production terminal-payload path. The source pin may remain as supporting evidence but cannot substitute for execution.
6. Make PostgreSQL startup, commands, shutdown, status verification, and cleanup bounded and fail-loud.
7. Add mutations for each repaired weakness and run a fresh full gate.

Commits `f391973` and `fb5e9d5` stand locally and must not be amended. Pass 4, push, deployment, migration, retrospective sweep, and Cohere activation remain unauthorized.
