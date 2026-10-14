# CDMSS Rerank Telemetry: consolidated PRD, version 2.1

**11 August 2026. Supersedes version 2.0, which lost eleven normative requirements in consolidation and is withdrawn.**

**What this is.** The single authoritative specification for Stage 0a telemetry. It consolidates `CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026.md` and `CDMSS-RERANK-TELEMETRY-KICKOFF-ADDENDUM-11-AUG-2026.md`, applies every amendment in place, and closes requirements the on-path kickoff versions 1 to 10 left unaddressed. The build instruction that pairs with it is `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`.

**Read this and the build kickoff. Nothing else.** Both source documents are superseded. No requirement lives outside this pair.

**Authority.** `CDMSS-RERANK-REMEDIATION-PLAN-v3.1-11-AUG-2026.md`, section 6 decision B.

**Approved scope.** Stage 0a telemetry architecture. Stage 0b canary is specified here and is not built.

**Not approved.** C0.5 lease, C0.6 backfill exclusion, C1 semaphore, C2 note concurrency, Q1 quota, F1 fallback policy, or any ranking change.

---

## 0. Decisions log

**A1. The linked-run rule is role-based.** Section 7's original "exactly one correctly linked terminal retrieval-run record" would fail a correctly instrumented audit that ran the normative channel, because it has two linked rows. Replaced in §7.

**A2. The scorer-context HMAC requirement stands and is role-scoped.** An earlier on-path version tried to weaken it for small candidate pools. `assembleAuditContext` always renders a context, so the requirement is restored and §4.3 says which role carries it.

**A3. Route coverage excludes one named case.** `lvc_recall` rows from `app/api/appropriateness/route.ts` carry `unknown_route`, because that surface has no taxonomy member. Excluded by name in §7, not by role.

**A4. Deployment, canary execution, canary evidence and final acceptance are out of scope for this build.** Section 5 step 10, and sections 9 and 10, are marked accordingly. Every still-live report requirement is in the kickoff's report list, which is authoritative and complete.

**A5. The migration is an admin route.** There is no migration runner and no ledger in this repository. Section 4.2 says so.

**A6. `not_served` is admissible at the canary gate, and the explicit null is admissible at stage level only.** Section 7's batch requirement predates both and is amended. `not_served` is a valid served class on a batch. A stage that made no request declares null. A batch record with a null class is a defect, because a batch record exists only where a request was planned. The counting helper must treat a null as nothing rather than as unattributed; the validator must reject it on a batch.

**A7. Source-text pins are re-pinned, not required to pass unchanged.** Section 6.1's original wording assumed the pins would be untouched. Several pin expressions this build necessarily changes. The requirement is that each pin preserves the same invariant against the new shape.

**A8. The base tables are not added to the Lab connector's blocked-relation list.** Version 2.0 required it. That list is `BLOCKED_RELATIONS` in `lib/sql-guard-core.ts`, whose own comment ends "Adjust the view, never this list, to widen." Two committed tests assert the literal is byte-identical, one of them titled `lib/sql-guard-core.ts was NOT edited by this build`. The list blocks six relations that carry raw clinician-typed text; the connector's own header states the database it fronts already carries prescription uid and is treated as de-identified. The requirement is controls **no weaker than `opd_note_audits`**, and `opd_note_audits` is readable through that connector, so blocking would be stronger than required at the cost of breaking a guard. Section 4.2 states the control set instead. If the list is the right long-term home, that is V's ruling to make on a defect report, not this build's to take.

**A10. The manifest records the backend that served, not only the backend intended.** `lib/rerank.ts` falls through from Cohere to the judge when Cohere is the environment default and its health check fails. Intended Cohere means one expected batch; the judge then serves several. Under section 7's never-waived batch reconciliation every such row would be partial by construction, so the batch count is derived from the backend that served. `served_backend` and a downgrade flag are required manifest fields. This is an observation requirement. Nothing about backend resolution changes.

**A11. A dependency seam that cannot report its own status records `not_collected`, never a guessed status.** `MultiQueryDeps.variantsFn` returns a bare string array, from which `parsed_empty` and `failed_open` are indistinguishable. Inferring either would put a fabricated fact in a provenance record. `not_collected` is admissible and is not a defect. Separately, the two statuses **are** distinguishable in the real generator and must be separated there, which needs an inner `try` around the parse.

**A12. Eleven requirements lost in the 2.0 consolidation are restored**, each marked **RESTORED** at its point of use: the run-id derivation prohibition, the process-global-state prohibition, the synthetic-audit-row prohibition, the five attribution proof conditions, the console-log and guessing prohibitions, the unattributed-before-C0 gate, the shared-`governedChat`-caller compatibility test, the overhead measurement requirement, all ten C0 queries, the four attribution tests, and the blocked-attribution full stop.

---

## 1. Objective

Build durable, invocation-level telemetry for every OPD retrieval execution so the current C0 state can be measured without changing ranking behaviour.

The system must answer, without relying on console logs:

- Which route and invocation started each retrieval?
- Which provider and model actually served every expansion and rerank batch?
- Which attempts received 429, another HTTP error, a timeout, a transport error, a bad response, or success?
- Did every expected rerank score arrive and parse as a finite number?
- What exact candidate order entered reranking, and what exact context reached the scorer?
- Did the retrieval complete, fail, lose a persistence race, or never produce an audit row?
- Did worker, **active** provider-backfill and hosted-lab retrieval work overlap?
- What provider usage and token cost did reranking create?

Telemetry is the deliverable. Do not infer remediation from the canary. Do not implement a load control.

---

## 2. Evidence boundaries

The retained census supports counts, not logical-call rates:

- 99 observed worker-path 429 warning lines.
- 21 terminal local-fallback lines on the traceless utility path.
- Three of 135 observed worker invocations contained a 429 warning in one retained window, subject to log completeness.
- Zero exact `[rerank judge] batch failed` markers.
- 360 provider-backfill route invocations, **not** 360 active workloads.

**Do not encode any of the following as established facts, in code, in a comment, in a test name, or in the build report:**

- That all 21 local fallbacks came from reranking.
- That 24 calls recovered.
- That all 537 stored audits came from the worker.
- That no batch-failure marker means every score was present and numeric.
- That a provider-backfill cron tick performed retrieval work.
- That process-local `inFlightAtError` measures project-wide concurrency.

The build report states explicitly that it asserts none of these six, naming them.

---

## 3. Non-negotiable constraints

1. **Observation only.** Do not change backend, provider order, model, prompt, batch size, retry count, retry timing, fallback behaviour, candidate selection, source weighting, sort behaviour or scorer context.
2. **Keep the traceless rerank route.** Do not pass a parent trace ID into `governedChat`. Doing so changes transport behaviour.
3. **No telemetry input or output inside parallel rerank batches.** Collect batch facts in memory and persist the terminal manifest after all batches settle.
4. **The durable start precedes retrieval work.** A killed serverless invocation must remain visible as `started` and later reconcile to a declared terminal state.
5. **No clinical text.** Store identifiers, enums, counts, timings and keyed HMACs only. Never query text, passage text, prompts or rendered scorer context.
6. **Do not change `RERANK_BACKEND` or `JUDGE_BATCH`.** Both are ranking-treatment changes.
7. **Preserve callback-independent batch order.** Manifest batches use candidate index boundaries, never completion order.
8. **Fail visibly.** Where durable telemetry is fail-soft to protect audit availability, expose and reconcile the gap. Do not call it complete or atomic.
9. **Stop on semantic risk.** If served-provider attribution cannot be exposed without changing transport or fallback behaviour, report the blocker before implementing an alternative.

---

## 4. Required architecture

### 4.1 Retrieval execution identity

Create one **UUID** `retrieval_run_id` for each retrieval execution, allocated at the retrieval boundary before any durable write is attempted. A failed write never makes an allocated id unknown.

**RESTORED. It is not an audit id and must not be derived from `(uid, engine_version)`.** The id must distinguish:

- Concurrent worker and backfill executions for the same note.
- A losing `ON CONFLICT` computation from the persisted winner.
- Retries and manual runs.
- Deliberate A/A replicates.
- Failed or unsaved executions.

Every execution also carries a `retrieval_role`, declared before retrieval runs, from a closed set: `primary`, `normative_channel`, `lvc_recall`, `lab_direct`, `lab_multi_query`.

**RESTORED. Thread a typed telemetry context explicitly through retrieval and reranking. Do not use mutable process-global state in a serverless process that can handle concurrent requests.** That applies to the context, the capture object and every id, not only to invocation ids.

### 4.2 Dedicated tables, applied by an admin route

**There is no migration runner and no ledger.** `migrations/*.sql` files in this repository are documentation. Schema changes are applied by idempotent admin routes under `app/api/admin/migrate-*`, each inlining its own SQL, gated by `requireAdmin` or an unlocked admin session. There are thirty-eight such directories, twenty-nine of which export a `POST`. The absence of a runner is established by there being no code that reads `migrations/*.sql`, not by any route's header comment. `migrations/0035_opd_audit_retrieval_telemetry.sql` has therefore never been applied and cannot be.

Stage 0a creates `app/api/admin/migrate-retrieval-telemetry/route.ts` and keeps the `.sql` file as its mirror, with a test asserting the two cannot drift.

Three tables. `opd_audit_retrieval_telemetry` for retrieval executions. `opd_retrieval_invocations` for invocation accounting and overlap analysis. `opd_retrieval_telemetry_failures` for per-run telemetry-write failure evidence.

**The required scalar field set for `opd_audit_retrieval_telemetry` is exactly the set migration 0035 declares, plus the additions in the kickoff's D2.** The build report enumerates every column verbatim, so the set is a stated requirement rather than an accident of what happens to be in the file.

Use a database constraint for the persistence-state vocabulary. **The exported TypeScript constant is the source of truth. The `.sql` mirror is hand-typed and held to it by a parity test.** Do not attempt to generate SQL from the constant.

Indexes are required for nightly reconciliation, audit linkage, route and invocation overlap, experiment linkage, persistence state, retrieval role, stale invocation scans, and failure evidence by run, phase and time.

**RESTORED. Do not create synthetic audit rows to populate `audit_id`.** An unlinked row stays unlinked.

**Retention, access and deletion.** `uid` on `opd_audit_retrieval_telemetry` is a re-identification key and must receive controls no weaker than `opd_note_audits`. The other two tables carry no `uid`; they are join keys to a `uid`-bearing table and inherit the same handling.

- **Retention.** Ninety days, from `started_at` on the two tables that have it and from `observed_at` on the failure table. Stated in a `COMMENT ON TABLE` on each, with the correct column named per table.
- **Deletion.** Operator-scheduled purge. Not automatic, not a trigger. The route's header names the purge as owed and unimplemented.
- **Access.** The admin gate, matching `opd_note_audits`. **`lib/sql-guard-core.ts` is not edited.** Its blocked-relation list exists for tables carrying raw clinical text, the telemetry tables carry none by construction, `opd_note_audits` itself is not on that list, and the file's own comment says to widen or narrow through a view. Two committed tests assert that list is byte-identical.
- **Non-exposure.** No clinician-facing surface and no existing audit reader selects from any of the three tables. Asserted by a source-text scan over `.ts` and `.tsx`, with its limits stated: it does not cover dynamically composed SQL, `.mjs` scripts, Metabase, or the connector's own tool description.

### 4.3 Manifest schema

Version the manifest independently from application deployment. At minimum it contains:

- The retrieval role, route, route class, invocation id and deployment SHA.
- Expansion status, served route class, served model, and its ordered attempt list.
- Variant-generation status, served route class, served model, attempts and token usage, on the multi-query role. **An injected dependency that cannot report its own status records `not_collected`. A guessed status is a fabricated fact and is worse than an admitted gap.**
- The ordered pre-rerank candidate ids and their keyed passage HMACs.
- **Two candidate counts, not one:** the fused pool size after the cap, and the hydrated row count. They can differ, and the difference is a dropped row.
- The intended backend and model, **the backend that actually served and whether it was a downgrade**, the expected batch count derived from the backend that served, and per batch: index boundaries, intended provider and model, served route class, served model, ordered attempts, outcome, expected and finite score-key counts, and token usage.
- The final ordered candidate ids.
- A keyed HMAC of the exact rendered scorer context. **Required on role `primary`, computed over the exact `citedContext` bytes returned by `assembleAuditContext`. Null on every other role, and that null is not a defect.** Plain hashes of patient-derived text are not acceptable. HMAC-SHA-256, dedicated secret, versioned key identifier.
- Retrieval configuration, **the corpus version and the index version.** The index version identifies the embedding column and embed model actually used, because that determines which candidates exist.
- **Active provider-backfill run id, target, and active-or-idle state, when applicable.** The active-or-idle flag is load-bearing: without it a cron tick cannot be distinguished from real work, which §2 forbids twice.
- Active hosted-lab run or experiment identifiers when applicable.
- Retrieval outcome, distinguishing a successful retrieval with hits, a successful retrieval with zero hits, and a failed retrieval.

**Ordered attempt outcomes use the committed taxonomy.** `TransportAttemptOutcome` already exists with exactly the required values: `http_429`, `http_other`, `timeout`, `transport_error`, `bad_response`, `success`. **`classifyAttemptOutcome` produces five of the six. It can never return `success`, which is pushed literally at the two success call sites.** Do not route a success through the classifier.

**Two existing columns need writers, and neither had one in any earlier on-path version.**

- `rerank_429_attempts` is the count of attempts whose outcome is `http_429`. `batchCounters().retries_429` already computes it correctly.
- `rerank_unattributed_batches` is the count of batches whose served route class is `unattributed`. **`batchCounters()` computes `unattributed` as an `else` branch, so once `not_served` and a null class exist it would over-count. The helper must be corrected to test equality, and a `not_served` counter added.** The two facts must not be merged.

### 4.4 Served-provider attribution

Establish how the actually served provider, model and attempt sequence can be surfaced from the existing traceless `chatWithFallback` path.

Attribution must survive both a success and a total failure. When every route fails, no provider served, and the record must say so rather than naming the last one attempted. Where a completion may have arrived and attribution is unavailable, that is `unattributed`. Where telemetry can prove no completion arrived, that is `not_served`. **The two are different facts and must not be merged.**

A malformed served completion is still a served completion. A parse failure preserves its provider, model, attempts and token usage.

**RESTORED. Console-log parsing is not an acceptable durable source. Do not guess from requested model, environment or error timing.**

**RESTORED. An implementation may add optional structured transport metadata to the existing return value or an invocation-scoped observer, provided tests prove all five of:**

1. Request parameters are byte-equivalent.
2. Provider selection and fallback order are unchanged.
3. Retry behaviour is unchanged.
4. Existing callers remain behaviourally compatible.
5. No parent trace ID is introduced.

This build modifies `chatWithFallback`, so all five must be proved, not assumed.

**RESTORED. If served-provider attribution cannot be exposed without changing transport or fallback behaviour, that is a full stop.** Report to V and stop. Do not design an alternative and do not proceed with `unattributed` as a workaround. Whether to modify shared transport beyond the approved additive change is V's decision, not the build's.

### 4.5 Persistence and reconciliation

1. Insert `started` before expansion or retrieval provider work.
2. Collect expansion and rerank details in memory.
3. Write one terminal manifest update after retrieval settles.
4. Link `audit_id` only after the actual audit persistence result is known.
5. Preserve losing-race telemetry even when another audit row wins the conflict.
6. Reconcile stale `started` rows after the maximum invocation duration plus a **preregistered** grace period. The value is fixed in a shared configuration module and recorded in the build report **before** any canary opens. It cannot be tuned afterwards to make a gate pass. Changing it restarts the window.

**Declare whether the audit write and final telemetry link are transactional.** They are not, and cannot be here. The precise reason: `lib/db.ts` exports `sql` as a `Proxy` with only an `apply` trap over a bare function target, so the driver's own `transaction` method is not reachable, and even that method could not span the application logic between the audit insert and the telemetry link. So use idempotent updates with an explicit revision guard plus a reconciler, and **state that in the build report as a declaration**, not an assumption. Report every mismatch rather than claiming atomicity.

The terminal update must be retry-safe and must never replace a valid terminal record with a less complete state.

### 4.6 Rerank cost

Aggregate provider usage by the served provider and model, never the requested one, **countable by provider, model, attempt and token usage.** Use the same pricing source and effective-date discipline as existing cost reporting, and state both. Keep unknown usage explicit. Do not turn missing token data into zero cost. Local, not-served and skipped stages are unpriced. `unattributed` and `parse_failure` stages are priced from their preserved usage.

---

## 5. Implementation order

1. Map every production, backfill, manual and A/A retrieval entrypoint and define the route taxonomy.
2. Prove or block served-provider attribution on the traceless path, against all five §4.4 conditions.
3. Add schema, indexes, the retention and access note, and typed manifest definitions.
4. Add durable retrieval start and terminal lifecycle writes.
5. Instrument expansion and rerank in memory without changing model inputs or scheduling.
6. Link telemetry to persistence outcomes, including losing races and failed saves.
7. Add stale-start and nightly-window reconciliation queries or tooling.
8. Add cost aggregation.
9. Run compatibility, privacy, byte-identity and overhead tests.
10. **Out of scope.** Canary deployment happens after V authorises it on the build report.

---

## 6. Required tests

### 6.1 Ranking invariance

- Fixed expansion and candidate pool produce byte-identical ordered output with telemetry enabled and disabled, **with the same injected dependencies running in both cases.**
- Exact rendered scorer context is byte-identical.
- Batch boundaries and prompts are byte-identical.
- Callback completion order cannot reorder manifest batches or ranking inputs.
- **Existing backend-resolution and retrieval determinism pins are re-pinned to preserve the same invariant against the new shape.** Several pin expressions this build necessarily changes. A pin may be rewritten; the invariant it protects may not be weakened.

### 6.2 Attribution and score completeness

**RESTORED, all four:**

- Cloud success records the actual provider and model, and success.
- A retry records the ordered attempt sequence and the final route.
- Local substitution records the local provider and model, never the intended cloud model.
- An unavailable route is `unattributed`, never inferred.

Plus:

- **Terminal failure, timeout, parse failure, missing score key and nonnumeric score are distinct outcomes.** Timeout is a member of the batch-outcome enum, not a synonym for terminal failure.
- A legitimate numeric zero remains distinguishable from a default inserted for a missing or invalid score.
- Every attempt carries one of the six taxonomy outcomes.
- `rerank_429_attempts` equals the count of `http_429` attempts. `rerank_unattributed_batches` equals the count of batches whose served class is exactly `unattributed`, and a `not_served` batch is not counted into it.
- A total transport failure records no served provider.
- A parse failure records its served provider, model and usage.

### 6.3 Lifecycle and concurrency

- A start exists when retrieval throws before reranking.
- A terminated or stale start reconciles to the declared state.
- Concurrent runs for the same `(uid, engine_version)` retain separate rows.
- A losing persistence race retains its telemetry and does not attach to the winner's audit.
- Retried terminal writes are idempotent.
- An old invocation cannot downgrade or overwrite a newer terminal result.

### 6.4 Privacy and compatibility

- The manifest types carry no field that could hold clinical text. The assertion must fail when such a field is added, and must not be able to pass on an empty slice.
- **HMAC output changes with key version, and cannot be reproduced with an unkeyed hash fixture.**
- **Existing audit readers and clinician-facing responses do not expose the new tables.**
- **RESTORED. Shared `governedChat` callers remain compatible.** Not only consumers of the attribution API. Every traceless caller lands in `chatWithFallback`, which this build edits.

### 6.5 Overhead

- **RESTORED. Measure** start-write latency, terminal-write latency, manifest size, retrieval wall time and audit completion rate. Synthetic measurement where a live database is unavailable, marked as such.
- Set numeric overhead guardrails before the canary. V approves them.
- **Do not approve instrumentation whose timing materially changes the throttling behaviour being measured.** The durable start precedes provider work, so it adds latency before the first opportunity for a 429. V judges the measured start-write latency against the throttling timing, not a generic budget. This is an acceptance criterion, not a metric.

---

## 7. Stage 0b canary gate

Not part of this build. Specified so the build report can be read against it.

Run one complete nightly canary on one deployment SHA and one telemetry schema version. A window is assigned by worker invocation start time and closes only after every invocation started in the scheduled window reaches a terminal or explicitly reconciled state and selected audits reconcile.

The canary passes only when 100% of completed persisted audits have:

- **Exactly one linked terminal retrieval run with role `primary`. Exactly one with role `normative_channel` when that channel was declared. None with that role when it was not. No other role linked to an audit.**
- Recognized telemetry and manifest versions.
- Expansion status.
- Equal expected and recorded rerank batch counts. **This is never waived.** A soft fallback to input order does not excuse a missing batch record. It requires one synthesised record per planned boundary.
- **A declared served route class for every batch record: a provider, or `unattributed`, or `not_served`. Absence of the field is not a declaration.** The explicit null belongs at stage level, on expansion and variant generation, where a stage can make no request. A batch record exists only where a request was planned, so a null on a batch is a defect and not a declaration. The type may permit null defensively; the gate does not.
- **A final scorer-context HMAC on the `primary` row.** Null on other roles is correct.
- Terminal persistence state.

Also require:

- Every eligible retrieval start is durable or covered by a higher-level reconciliation record proving why it is absent.
- Every observed fallback and failure log reconciles to telemetry.
- Worker, **active** provider-backfill and **active** hosted-lab intervals are available for overlap analysis. An idle cron tick is not an interval.
- No instrumentation correction, behaviour-affecting configuration change, or overhead-guardrail breach occurred.
- **Route coverage.** Every role carries a recognised route, except `lvc_recall` rows whose route is `unknown_route`, which come from `app/api/appropriateness/route.ts` and are excluded by name.

An `unattributed` batch is recorded telemetry and fails the served-attribution objective. **RESTORED: it must be resolved before C0.** A missing batch record is telemetry failure. Report the two separately.

**No gate is waived.** A written amendment to this document, made before a canary opens, is not a waiver. Discovering a gap during or after a window and declaring it acceptable is.

If any gate fails, correct it and restart. Before restarting, distinguish two causes. An instrumentation defect is fixed and restarted. Production behaviour the telemetry recorded correctly, which the gate was not written to expect, is a finding for V and not another correction cycle. **Two restarts from the same cause is the point to stop and report.** A corrected or incomplete canary does not count toward the seven-window C0 baseline.

---

## 8. C0 readiness, not C0 results

Not part of this build beyond the query text. **RESTORED: all ten queries, not four.**

1. Started, completed, failed, persisted, partial and aborted runs.
2. Eligible retrievals and coverage percentage.
3. Expected versus recorded rerank batches.
4. Actual provider and model, and route-class counts.
5. Attempt outcomes, and terminal failure and fallback counts.
6. Score-completeness defects.
7. Invocation overlap by worker, **active** backfill and hosted lab.
8. **Missingness sliced by endpoint, latency, failure status, provider route and invocation.**
9. Latency distributions and telemetry overhead.
10. Token usage and cost by served provider and model.

Items 5 and 6 are the two this workstream exists to produce. Neither may be dropped.

**A future C0 window counts only at 99.5% or greater terminal or explicitly reconciled partial coverage, 100% capture of observed fallback and failure classes, complete terminal-manifest batch reconciliation, and no outcome-dependent missingness.**

**Nobody may compare a telemetry-era number to the single night of console logs from 10 to 11 August.** Those two worlds are not comparable and the earlier one is gone. Once telemetry lands, C0 is the current system plus telemetry overhead, and the pre-telemetry system can never be measured again. That is acceptable because every state after C0 carries the same overhead. **Record the measured overhead in the C0 baseline report as part of the configuration, not a footnote.**

---

## 9. Deliverable

The build report is `CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md`. **Its contents are specified in the build kickoff's report section, which is authoritative and complete.** Nothing in the superseded section 9 survives outside it.

Three items are named here because they are easy to lose:

- **The entry-point and route taxonomy**, as mapped in step 1.
- **The atomicity declaration** from §4.5, stated as a declaration.
- **The harness SHA, recorded separately from any served deployment SHA.** This requirement is from the addendum's section 1, not from the superseded section 9. A clean local tree proves nothing about what Vercel is serving. The served SHA is canary-era.

---

## 10. Acceptance

Superseded for this build. The build is accepted on the gate and report in the kickoff. These prohibitions survive and bind now:

- A canary gap is never waived.
- A requested model is never reported as a served model.
- Missing usage never becomes zero cost.
- Duplicate executions never collapse into one record.

---

## 11. Operational context

### 11.1 Repository state

Build in the clean `exp/rerank-telemetry` worktree at `fc28e0fdce015e9e303944e4197b19534c31c383`. The earlier instruction to build at `81b7c93` applied to the off-path half, which is committed. `81b7c93` has neither the migration nor the telemetry core.

**Four files carry unshipped arm C work that must not enter this work, this branch or this diff:**

```
lib/lvc.ts                                  the weaker low-value-care fix, unshipped
lib/opd-audit-changelog.ts                  its entry describes that fix as shipped, and it is not
lib/__tests__/lvc-judge-attribution.test.ts
lib/__tests__/lvc-judge-pinning.test.ts
```

Those changes are parked at `park/lvc-arm-c-unshipped-11-aug-2026`. **`main` is clean; the files are not uncommitted any more.** Do not merge that branch and do not read from it. The prohibition is on those changes, not on the files. `lib/lvc.ts` at `fc28e0f` is safe to edit for the single purpose in the kickoff's D7. **`lib/opd-audit-changelog.ts` and the two low-value-care test files are not edited at all.**

### 11.2 The engine freeze

V declared a one-month engine freeze on 11 August and lifted it for remediation work. **It will be re-declared at Stage 3, and the clock restarts there. This build is inside the lift, and because it changes no ranking behaviour it does not consume it.**

If a defect is found on the way, write it in a list and leave it. V holds the only exception and signs each one in writing.

### 11.3 Scope discipline

Approved: Stage 0a. Stage 0b is specified and not built.

Not approved, and not to be built, prototyped, or prepared for: C0.5 worker-overlap control, C0.6 backfill exclusion, C1 rerank semaphore, C2 worker note concurrency, Q1 quota, F1 fallback policy, and any change to `RERANK_BACKEND` or `JUDGE_BATCH`.

Do not start the seven-window C0 baseline. V authorises it after reading the build report.

### 11.4 Verified facts, so the build does not stall

The foreign-key target exists: `migrations/0007_opd_note_audits.sql` declares `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, so `audit_id UUID NULL REFERENCES opd_note_audits(id)` is valid.

Bedrock cannot serve the rerank judge. `governedChat` gates it on an explicit option the judge call does not pass.

The remaining codebase facts the build depends on are enumerated in the kickoff's section 2, each checked against the tree at `fc28e0f`.
