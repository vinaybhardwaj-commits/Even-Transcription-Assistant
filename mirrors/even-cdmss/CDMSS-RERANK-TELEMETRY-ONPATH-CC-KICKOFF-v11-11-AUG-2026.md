# CDMSS: Rerank telemetry, on-path build kickoff, version 11

**Claude Code kickoff. 11 August 2026.**

**Supersedes versions 1 through 10 entirely.** Do not read them.

**Read exactly two documents: `CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md` and this one.** The PRD is the specification. This is the build instruction. Every earlier governing document and addendum is consolidated into the PRD, so there are no external overrides to reconcile.

If you find a decision neither document settles, flag it in the report and leave the code alone.

---

## 0. Preflight, then the preparatory commit

**Identity checks first.**

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

Expected: `exp/rerank-telemetry`, `fc28e0fdce015e9e303944e4197b19534c31c383`, clean. Stop if any value differs.

**Then a preparatory commit, before any code.** The PRD and this kickoff are not on this branch and are not in git. Copy them across. The commit contains only:

```gitignore
!/CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md
!/CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md
!/CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md
```

plus the two documents. The third line is for the report you write at the end. Record the SHA-256 of both documents. Verify with `git show --stat` that the commit holds documentation and allowlist lines only.

---

## 1. Where this sits

The off-path half of Stage 0a is committed at `fc28e0f`. This is the other half. It runs on the retrieval critical path of every OPD audit.

Nothing about ranking may change. PRD section 3 lists the nine non-negotiable constraints. Read them before writing code, not after.

---

## 2. Established facts

Checked against the tree at `fc28e0f`, except the three items at the end.

**There is no migration runner and no ledger.** `migrations/*.sql` files are documentation. There are 38 directories under `app/api/admin/migrate-*`, 29 of which export a `POST`. Each inlines its own SQL and is gated by `requireAdmin` or an unlocked admin session. Confirm the two counts yourself and put them in the report; do not carry these numbers forward on my word.

**There is no route for `opd_audit_retrieval_telemetry`, and nothing in `app/` references that table**, so migration 0035 has never been applied and cannot be. That is the fact the build depends on. Do not repeat any claim about what a route's header comment says; earlier versions of this kickoff asserted one and it was wrong.

**Migration 0035 contains `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and a `COMMENT ON TABLE`.** Its comment already states observation-only, `uid` as a re-identification key, admin access, ninety-day retention from `started_at`, and an operator-scheduled purge. Carry that forward, and adapt rather than copy it for the two new tables. It has five batch counters plus one attempt counter, and no not-served counter. **It already declares `trace_id TEXT NULL`**, so no new trace column is needed and no naming decision is open.

**`TransportAttemptOutcome` already exists with exactly the taxonomy the PRD requires**: `http_429`, `http_other`, `timeout`, `transport_error`, `bad_response`, `success`. **`classifyAttemptOutcome` produces five of the six.** It never returns `success`, because it is only called on a failure. `success` attempts are pushed at the call sites. So the manifest can carry all six, but only if the success push sites are instrumented too. Nothing needs inventing.

**`batchCounters()` computes `retries_429` and `unattributed`, and its route attribution has a bug this build must fix.** Its class attribution is a chain of `if` and `else if` over `vertex`, `openrouter` and `local`, with a bare `else` that increments `unattributed`. Adding `not_served`, and permitting a null class for a skipped stage, would make both fall into that `else` and be counted as unattributed. **Change the final branch to `else if (b.served_route_class === 'unattributed')` and add a separate `not_served` counter.** A null class increments nothing. `rerank_429_attempts` and `rerank_unattributed_batches` are the two columns these feed. Both exist in 0035 and no earlier version of this kickoff gave either a writer, so both would have stayed at zero.

**There are two producers of `rerank_backend: 'none'`, not three.** The zero-candidate branch of `rerank()` returns an empty array and stamps nothing. The producers are the single-candidate early return and `inputOrder()`.

**`rerankJudge` cannot throw.** Its only failure point is inside a per-batch `try/catch` that warns and continues, and the post-loop map and sort cannot throw. Production resolves to the judge backend. **So `inputOrder()` is reachable only when Cohere is selected and the error is untyped.**

**`rerankJudge` is not exported.**

**`rerankCohere`'s third and fourth positional parameters are injected dependencies**, `fetchImpl: typeof fetch` and `recordCost`. `RerankDeps.cohereFn` is typed `(q, c) => ...`, so `deps.cohereFn ?? rerankCohere` compiles only because extra parameters are assignable.

**`TransportAttempt.tier` is `'vertex' | 'openrouter'`** and cannot represent Ollama.

**The intended-local path in `lib/llm.ts` reports `attempts: []`** while making a real provider request.

**`attachTransportAttribution` sets `configurable: true, writable: true`.** Existing low-value-care code reads exactly two of its fields, `dispatched_provider` and `dispatched_model`.

**Bedrock cannot serve the rerank judge.** `governedChat` gates it on `opts?.bedrock`, which the judge call does not pass.

**The scorer context is assembled once per audit, after both retrievals return.** `assembleAuditContext(hits, normHits)` returns `{ sources, citedContext }` over both hit sets, and `buildOpdAuditUser` renders a deterministic placeholder when it is empty. **The combined context does not exist inside either retrieval call, so the primary terminal write cannot happen immediately after primary retrieval.**

**`retrieve()` holds two genuinely different candidate arrays.** `fusedIds` after the pool cap, and the hydrated `hits`, whose length is less than or equal to it because the re-read can return fewer rows.

**There are two zero-candidate shapes.** An empty fusion, which returns before the rerank block exists, and a non-empty fusion whose hydrate yields nothing, which reaches the rerank guard and falls through.

**Four in-scope paths swallow retrieval exceptions into an empty hit list.** `defaultRetrieve` and `normativeChannelRetrieve` in `lib/opd-note-audit.ts`, `defaultRecall`'s semantic leg in `lib/lvc.ts`, and the per-variant catch in `lib/multi-query.ts`.

**`labRetrieve` in `lib/mcp-tools.ts` has a catch, and it splits.** The `try` opens at line 1077 and covers both retrieval branches. Its catch at 1123 returns an error result for a `RerankBackendError` and rethrows everything else:

```ts
  } catch (e) {
    if (e instanceof RerankBackendError) return err(`${e.name}: ${e.message}`);
    throw e;
  }
```

So one class of failure is converted to a result and every other class propagates. **Record `retrieval_failure` inside that existing catch, on both arms, before the return and before the rethrow.** Do not add a `finally`: it would also fire on the success path, where the outcome is already recorded. Do not change which errors return and which throw.

**`defaultRecall` in `lib/lvc.ts` performs two `sql2` reads outside its own `try`.** They sit in a ternary at lines 181 to 183; the `try` opens at 189 and its catch guards only the semantic leg. A throw from either read leaves the row at `started` and reaches the caller. Record `retrieval_failure` before the error leaves the function, and keep the throw exactly as it is.

**`generateQueryVariants` has six distinguishable outcomes but only five code paths today.** A usable set, a valid empty array, an array with no usable strings, and valid JSON that is not an array are each reachable separately. **A `JSON.parse` throw and a `governedChat` throw land in the same catch**, which warns and returns `[]`. So `parse_failure` and `failed_open` are one path in the tree and two statuses in the manifest. Separating them needs an inner `try` around the parse inside `generateQueryVariantsWithTelemetry`. Write that inner try. Do not sniff error types.

**`lib/__tests__/retrieval-llm-determinism.test.ts` line 34 asserts the source of `lib/multi-query.ts` contains the literal `return [];`**. The test is titled `multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched`, and `fail-open (→ []) preserved` is the assertion message on that line, not the title. When `generateQueryVariants` becomes a thin wrapper over `generateQueryVariantsWithTelemetry`, that literal must still appear in the file, in the wrapper's own fail-open branch. A wrapper that returns `result.variants` and nothing else deletes the string and fails a test that is about behaviour this build must not change.

**`retrieve()` chooses its embedding column and model before any candidate exists.** `embCol` selects the column, and the model is `EMBED_MODEL` or `EMBED_MODEL_V2` accordingly. Those two facts are the whole of `index_version`. `retrieve()` also short-circuits embedding when the caller supplies `queryEmbedding`, in which case the column choice still holds but no embed call is made.

**`lib/backfill-runs.ts` exports `activeRun(worker: BackfillWorker): Promise<BackfillRun | null>`.** `BackfillWorker` is `'opd' | 'ipd'`, so the argument is required. **Call `activeRun('opd')`.** This is the OPD audit path and the IPD worker is out of scope. `activeRun` is not one round trip: it awaits `ensureRunsTable()` first, which on a cold invocation issues a `CREATE TABLE IF NOT EXISTS` and two `CREATE INDEX IF NOT EXISTS` before the `SELECT`. **So the added cost is four statements on the first retrieval of an invocation and one on each later retrieval.** Measure both, per D18. Do not describe it as one round trip.

**The `activeRun('opd')` read is fail-open, and it must be, because its first statement is unguarded DDL.** `ensureRunsTable`'s `CREATE TABLE` has no `.catch`, unlike its two index statements. A throw from that call would turn an audit that would have completed into one that never ran, which PRD section 3 constraint 1 forbids. **Wrap the call. On any failure record `active_backfill_run_id`, `active_backfill_target` and `active_backfill_state` as null, and proceed with the retrieval.** All three are nullable in D17 for exactly this reason. Do not add a `.catch` inside `lib/backfill-runs.ts`; that file is not on your edit list.

**There is no `WORKER_MAX_DURATION_SECONDS` in the tree.** What exists is a bare route literal, `export const maxDuration = 800` in `app/api/opd-audit/worker/route.ts` line 20. The constant is **new, and you create it** in `lib/opd-audit-runtime-config.ts` with the value 800. Earlier versions of this kickoff named it as an existing fact. It was not one.

**800 is the maximum `maxDuration` among the instrumented routes, not the value each carries.** The worker and the appropriateness route are 800. The run route, mini-backfill, lab-batch, the low-value-care A/A route and both MCP routes are 300.

**Two committed tests assert `vercel.json`'s cron array has exactly 16 entries**: `lib/__tests__/provider-switch-unit-d.test.ts` line 270 and `lib/__tests__/ipd-worker-batch-and-model.test.ts` line 57. Adding the reconciler cron makes 17 and breaks both.

**`lib/__tests__/provider-switch-unit-d.test.ts` line 255 is titled `lib/sql-guard-core.ts was NOT edited by this build`** and asserts the blocked-relation literal. `lib/__tests__/prognosis-outcomes-core.test.ts` reads the file at line 340 and asserts the same literal at line **341**. Two tests, one of them titled to forbid the edit. Two further tests are titled around not editing the guard, `provider-switch-unit-d.test.ts` line 245 and `vertex-primary-ladder.test.ts` line 358, but neither pins the literal.

**The committed comment on `audit_persistence_failed` says the audit write failed "or lost its ON CONFLICT race".** D9 sends `losing_conflict` to `completed_unpersisted`, so that comment becomes wrong the moment this build lands. Correct the comment text. Do not change the state.

**`MatchInput` and `matchLowValueCare` have no telemetry or context parameter**, and `defaultRecall` is the default recall for all surfaces that reach it. The A/A route also has passes that inject a pinned recall.

**`processDay` returns a plain object, and only two of the three worker modes call it.** Single-day and sweep call it inside a `try` whose catch returns 500. **Sweep loops over up to fourteen days and continues past a completed one, so a throw on the second or later day happens after earlier notes were already audited and persisted.** Re-audit does not call `processDay`, returns before that `try` opens, and has its own per-uid `try/catch` inside `mapLimit` that converts every throw into a 200 result row. It fetches each note inside `mapLimit`, returns `{ uid, error: 'note not found in db13' }` for an unresolvable uid, and reports `count: uids.length`.

**The reuse path returns before any retrieval**, inside `auditOpdNote`, and `startTrace` runs after that guard.

**Four in-scope callers pass `trace: false`.** `lib/mcp-tools.ts` line 465, `app/api/admin/opd-rescore-direction/route.ts` line 132, `app/api/admin/opd-dosing-backfill/route.ts` line 106, and `scripts/metamorphic-llm-report.mjs` line 50. `lib/lab-batch.ts` line 212 passes `trace: onBedrock`, which is not `false`. A fifth caller, `scripts/corpus-eval/matcher-stage2-dryrun.mjs`, is out of scope.

**The two admin routes build `reuse` unconditionally**, so they return at the reuse guard and never retrieve. They are therefore out of scope by construction, not by omission, and they are correctly absent from D6's site table, D9's owner matrix and D11's boundary list. **Confirm that reading for yourself before you rely on it**, and if either route can reach a fresh audit, stop and report rather than instrumenting it.

**Two `trace: false` callers do retrieve, and both matter for `trace_id`**: `lib/mcp-tools.ts` and `scripts/metamorphic-llm-report.mjs`. The metamorphic script is on the edit list, is a D11 boundary and has a row in the D9 owner matrix, so its rows carry a null `trace_id` for the whole of their life. Cover both in the test, not one.

**Nothing clones, spreads or structurally copies the `OpdNoteAudit`** on any path between `auditOpdNote` and the persistence call sites, so a non-enumerable property survives every one and `JSON.stringify` drops it from the two admin route bodies that serialize `audit` whole.

**`MultiRetrieveResult.variants` is `allQueries`**, index 0 the original expanded arm, `perVariantCounts` aligned.

**`MultiQueryDeps` is `{ retrieveFn?: typeof retrieve; rerankFn?: typeof rerank; variantsFn?: (question: string) => Promise<string[]>; expandFn?: typeof expandQuery }`.** Only `variantsFn` is hand-written. All four are injected in tests and in no production call site.

**Parameter counts today.** `retrieve(query, opts)` two. `expandQuery(question, traceId?)` two. `rerank(query, candidates, backend?, deps?)` four. `retrieveMultiQuery(question, opts, deps?)` three. `rerankJudge(query, candidates)` two.

**`injectAppSource` rewrites a single `VALUES ( … )` group** and returns early for tables not in `STAMP_TABLES`.

**`telemetryHmac` throws only on a zero-length or absent secret.** Its guard is `typeof secret !== 'string' || secret.length === 0`, with no `trim`. D8's `telemetryKeyMissingInProduction` does trim, so a key of only spaces is missing to the build guard and usable to the HMAC. **Make the two agree: add `trim` to neither and to both, and pick trimming.** A whitespace key is not a key. Change `telemetryHmac`'s guard to trim as well, and test the whitespace-only case on both sides.

**`tsconfig.json` includes only `.ts` and `.tsx`**, and `strict` implies `noImplicitAny`, so a `.ts` importing a `lib/*.mjs` fails `tsc --noEmit` with TS7016.

**The existing privacy test is a source-slice pin** anchored to the literal `export interface RetrievalManifest`. Renaming makes `indexOf` return −1 and the ban loop pass vacuously. It also asserts a serialized fixture has no run of thirty or more letters.

**The existing CHECK test slices between `persistence_state IN (` and the next `));`.** There is no `));` in 0035, so the slice runs to end of file and passes only because nothing else in those bytes matches its regex.

**`matchLowValueCare` has two production boundaries**, `app/api/appropriateness/route.ts` and `app/api/admin/lvc-judge-aa/route.ts`. `RETRIEVAL_ROUTES` already contains `lvc_judge_aa` and has no member for the appropriateness surface.

**`lib/lab-batch.ts` never writes `opd_note_audits`** and has a refusal branch of its own.

**`lib/sql-guard-core.ts` blocks `traces`, `trace_events`, `appropriateness_runs`, `ccb_briefs`, `care_track_assignments` and `opd_audit_feedback`.** `opd_note_audits` is not on that list. **Only `opd_audit_retrieval_telemetry` carries `uid`.** The invocation table and the failure table carry no patient identifier at all.

**Any flat `lib/*.ts` exporting a `*_VERSION` const becomes a coverage-bearing subsystem** in `scripts/lib/import-scan.mjs`, and `architecture:check` fails unless it is registered or listed in `UNREGISTERED`. `.mjs` files are never scanned.

**Not in the tree. Do not assume any of these three:**

- whether `RERANK_BACKEND` is set for Preview
- whether `CDMSS_TELEMETRY_HMAC_KEY` exists in Vercel
- the runtime truth of the 908,045 ms invocation the worker route header records

---

## 3. Decisions log

### D1. The migration is an admin route, mirroring the SQL file.

**Create `app/api/admin/migrate-retrieval-telemetry/route.ts`**, modelled on `app/api/admin/migrate-opd-audits/route.ts`: `export const runtime = 'nodejs'`, `requireAdmin` plus the `isAdminUnlocked` fallback, a `POST` that runs each statement in order and returns a `steps` record. Every statement idempotent.

**Update `migrations/0035_opd_audit_retrieval_telemetry.sql` to match it exactly**, as documentation, with a header comment naming the route. Add a source-text pin asserting that every `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, `COMMENT ON TABLE` and CHECK value in the route is also in the `.sql`, and the reverse.

**The stop rule.** The route's first step counts rows in `opd_audit_retrieval_telemetry` if it exists. If the table exists **with rows**, the route changes nothing, returns the row count and the state histogram, and the report says so. Legacy data needs a signed policy. If the table is absent or empty, proceed.

### D2. The complete DDL, three tables.

Existing columns of `opd_audit_retrieval_telemetry` unchanged, plus:

```sql
ALTER TABLE opd_audit_retrieval_telemetry
  ADD COLUMN IF NOT EXISTS retrieval_role             TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_outcome          TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_error_class      TEXT,
  ADD COLUMN IF NOT EXISTS persistence_settled_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_revision               INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expansion_served_model     TEXT,
  ADD COLUMN IF NOT EXISTS expansion_attempts         JSONB,
  ADD COLUMN IF NOT EXISTS rerank_not_served_batches  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rerank_soft_failed         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS served_backend             TEXT,
  ADD COLUMN IF NOT EXISTS rerank_backend_downgraded  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fused_candidate_count      INTEGER,
  ADD COLUMN IF NOT EXISTS hydrated_candidate_count   INTEGER,
  ADD COLUMN IF NOT EXISTS index_version              TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_run_id     TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_target     TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_state      TEXT,
  ALTER COLUMN app_source SET DEFAULT 'standalone';
```

**`trace_id` is 0035's existing `trace_id TEXT NULL`.** Add no column and open no naming question.

`index_version` is `embCol` plus the embed model that column implies, `EMBED_MODEL` or `EMBED_MODEL_V2`. That pair determines which candidates exist at all. **Stamp it into the capture immediately after the column choice and before the first fallible statement in `retrieve()`**, so a row that fails still records the index it was reading. When the caller supplies `queryEmbedding` there is no embed call, and the value is still the column and its model.

`active_backfill_state` is `'active'` or `'idle'`, read from `activeRun('opd')` in `lib/backfill-runs.ts`. It is load-bearing: without it a cron tick cannot be distinguished from real work, which PRD section 2 forbids twice. Its cost goes in the D18 overhead measurements, not in a claim that the cost is small.

**`retrieval_role` gets a CHECK, generated from `RETRIEVAL_ROLES`, and a conditional `NOT NULL`.** The CHECK is unconditional. The `NOT NULL` is applied only when the table is empty, because an existing row cannot have its role reconstructed. Do it as an explicit route step, not a `DO` block, so the decision is visible in the `steps` response:

```text
step: count rows. If 0, run  ALTER TABLE ... ALTER COLUMN retrieval_role SET NOT NULL
                  If > 0, skip it and record 'retrieval_role_not_null: skipped, table not empty'
```

Mirror the same conditional in the `.sql` as a comment stating the rule, since a `.sql` file cannot branch. The parity pin compares statements, so name that comment in the pin's allowed-difference list and nowhere else.

**`retrieval_outcome` stays nullable**, because the worker inserts `started` rows before retrieval starts. Guard it with state, and **generate the state lists from `RETRIEVAL_PERSISTENCE_STATES`, exactly as the state CHECK below is generated.** The shape is:

```sql
ALTER TABLE opd_audit_retrieval_telemetry
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_outcome_chk;
ALTER TABLE opd_audit_retrieval_telemetry
  ADD CONSTRAINT opd_audit_retrieval_telemetry_outcome_chk CHECK (
    (persistence_state = 'started' AND retrieval_outcome IS NULL)
    OR (persistence_state IN ( ...OUTCOME_REQUIRED_STATES... ) AND retrieval_outcome IS NOT NULL)
    OR persistence_state IN ( ...OUTCOME_EITHER_STATES... )
  );
```

Declare both sets next to `RETRIEVAL_PERSISTENCE_STATES` and assert in a test that the three sets partition all fourteen states with no overlap and none left out.

```text
OUTCOME_REQUIRED_STATES  retrieval_complete, persisted_complete, persisted_partial,
                         completed_unpersisted, persistence_refused,
                         audit_persistence_failed, persistence_skipped,
                         no_persistence_intended, persistence_unknown

OUTCOME_EITHER_STATES    aborted, retrieval_not_run, telemetry_persistence_failed,
                         audit_generation_failed
```

**`audit_generation_failed` is in the either set, not the required set.** D12 permits `started -> audit_generation_failed`, and a row settled from `started` never recorded an outcome. Nine plus four plus `started` is fourteen. Check that arithmetic in the test, not by eye.

The state CHECK is replaced, not edited:

```sql
ALTER TABLE opd_audit_retrieval_telemetry
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_persistence_state_chk;
ALTER TABLE opd_audit_retrieval_telemetry
  ADD CONSTRAINT opd_audit_retrieval_telemetry_persistence_state_chk
  CHECK (persistence_state IN ( ...the fourteen values from D9... ));
```

**Do not hand-type any value list, here or in the outcome CHECK.** Generate both from the constants. An earlier version hand-typed a count and got it wrong, and the version before this one hand-typed thirteen state names two paragraphs after forbidding it.

**Re-point the existing CHECK test.** It slices to the first `persistence_state IN (` and looks for `));`, which does not exist in 0035. **After this change there are three such blocks**, two in the outcome CHECK and one in the state CHECK. Re-point the test to the `ADD CONSTRAINT ... persistence_state_chk` block by name, give it a delimiter that exists, and add a second test that pins the outcome CHECK's two blocks the same way. Neither may pass on an empty slice.

New indexes on the existing table:

```sql
CREATE INDEX IF NOT EXISTS opd_art_role_state_idx  ON opd_audit_retrieval_telemetry (retrieval_role, persistence_state, started_at DESC);
CREATE INDEX IF NOT EXISTS opd_art_nonterminal_idx ON opd_audit_retrieval_telemetry (persistence_state, started_at) WHERE persistence_state IN ('started','retrieval_complete');
```

`opd_retrieval_invocations`:

```sql
CREATE TABLE IF NOT EXISTS opd_retrieval_invocations (
  invocation_id             TEXT PRIMARY KEY,
  kind                      TEXT NOT NULL,
  route                     TEXT NOT NULL,
  route_class               TEXT NOT NULL,
  app_source                TEXT NOT NULL DEFAULT 'standalone',
  deployment_sha            TEXT NULL,
  vercel_request_id         TEXT NULL,
  started_at                TIMESTAMPTZ NOT NULL,
  ended_at                  TIMESTAMPTZ NULL,
  closure_state             TEXT NOT NULL DEFAULT 'closure_unknown',
  declared_retrievals       INTEGER NOT NULL DEFAULT 0,
  telemetry_write_failures  INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT opd_ri_kind_chk    CHECK (kind IN ('retrieval','reconciler')),
  CONSTRAINT opd_ri_closure_chk CHECK (closure_state IN ('closed','closure_unknown'))
);
CREATE INDEX IF NOT EXISTS opd_ri_open_idx       ON opd_retrieval_invocations (started_at) WHERE closure_state = 'closure_unknown';
CREATE INDEX IF NOT EXISTS opd_ri_route_time_idx ON opd_retrieval_invocations (route, started_at DESC);
CREATE INDEX IF NOT EXISTS opd_ri_kind_time_idx  ON opd_retrieval_invocations (kind, started_at DESC);
```

`opd_retrieval_telemetry_failures`:

```sql
CREATE TABLE IF NOT EXISTS opd_retrieval_telemetry_failures (
  id               BIGSERIAL PRIMARY KEY,
  invocation_id    TEXT NOT NULL,
  retrieval_run_id UUID NULL,
  retrieval_role   TEXT NULL,
  failed_phase     TEXT NOT NULL,
  intended_state   TEXT NULL,
  observed_at      TIMESTAMPTZ NOT NULL,
  error_class      TEXT NOT NULL,
  CONSTRAINT opd_rtf_phase_chk CHECK (failed_phase IN
    ('invocation_start','work_declaration','retrieval_terminal','persistence_link','closure')),
  CONSTRAINT opd_rtf_run_chk CHECK (
    (failed_phase IN ('work_declaration','retrieval_terminal','persistence_link')
      AND retrieval_run_id IS NOT NULL AND retrieval_role IS NOT NULL)
    OR failed_phase IN ('invocation_start','closure'))
);
CREATE INDEX IF NOT EXISTS opd_rtf_run_idx        ON opd_retrieval_telemetry_failures (retrieval_run_id, failed_phase, observed_at DESC) WHERE retrieval_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS opd_rtf_invocation_idx ON opd_retrieval_telemetry_failures (invocation_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS opd_rtf_phase_time_idx ON opd_retrieval_telemetry_failures (failed_phase, observed_at DESC);
```

`error_class` is a class name. Never a message, never a value.

**The index count to update is one assertion, and it is not called a migration-index test.** `lib/__tests__/retrieval-telemetry-core.test.ts` line 71 counts `CREATE INDEX IF NOT EXISTS` occurrences in 0035 and expects 6. `every index is guarded` is that line's assertion message, not the test title; the title at line 68 is about idempotency and the retention and access controls. Raise the number to the true total after your additions and keep the guard clause it is really testing. No other test counts migration indexes.

**A `COMMENT ON TABLE` on each of the three. The text differs per table, because the tables differ.** Do not paste one comment three times.

```text
opd_audit_retrieval_telemetry
  observation only, no clinical text. uid is a re-identification key and carries controls
  no weaker than opd_note_audits. Ninety-day retention from started_at. Purge is
  operator-scheduled and is not implemented here. Admin access only.

opd_retrieval_invocations
  observation only, no clinical text, no patient identifier. Ninety-day retention from
  started_at. Purge is operator-scheduled and is not implemented here. Admin access only.

opd_retrieval_telemetry_failures
  observation only, no clinical text, no patient identifier. error_class is a class name and
  never a message or a value. Ninety-day retention from observed_at, this table having no
  started_at. Purge is operator-scheduled and is not implemented here. Admin access only.
```

### D3. Retention, access, and non-exposure.

PRD section 4.2 requires all three, and no earlier version of this kickoff addressed any of them.

- **Retention and deletion** are stated in the table comments above. The purge is named as owed and unimplemented. Do not write a trigger.
- **Access. Do not edit `lib/sql-guard-core.ts`.** Earlier versions of this kickoff told you to add the three tables to its blocked-relation list. That was wrong twice over. The requirement is controls no weaker than `opd_note_audits`, and `opd_note_audits` is not on that list, so blocking the telemetry tables would be *stronger* than the requirement. And two committed tests assert the literal is unchanged, one of them titled `lib/sql-guard-core.ts was NOT edited by this build`. The controls that apply are the ones `opd_note_audits` already has: admin gating on every route that reads it. State that in the report as the access answer. If you believe the blocklist is the right long-term home for these tables, put it in the defect list for V to rule on. Do not act on it.
- **Non-exposure.** No clinician-facing surface and no existing audit reader selects from any of the three tables. Assert it with a source-text search across `app/` and `lib/` for the three table names. **The allow-list is not "files this build creates".** Three existing files already name `opd_audit_retrieval_telemetry` and one of them is on your edit list. Allow, by exact path: the three new store modules, the migration route, the reconciler route, `migrations/0035_opd_audit_retrieval_telemetry.sql`, `lib/__tests__/retrieval-telemetry-core.test.ts`, and your own new tests. Then match on `SELECT`, not on the bare name, so a migration or a test naming the table is not a read of it. **State the limit of the test in the report:** a source-text search cannot see a dynamically composed table name, so it proves the tables are absent from every literal query and no more. This is a different property from text-freeness and needs its own test.

### D4. Instrumentation is opt-in, at six trailing parameters and one input field.

The capture parameter is **trailing, and it is not always third**.

```ts
retrieve(query, opts, capture?)                                    // 3rd
expandQuery(question, traceId?, capture?)                           // 3rd
rerank(query, candidates, backend?, deps?, capture?)                // 5th
rerankJudge(query, candidates, capture?)                            // 3rd, and now EXPORTED
rerankCohere(query, candidates, fetchImpl?, recordCost?, capture?)   // 5th, after both existing deps
retrieveMultiQuery(question, opts, deps?, capture?)                 // 4th
matchLowValueCare(input, deps?)                                     // via input.telemetry, see D7
```

When `capture` is undefined every telemetry statement is skipped, guarded by `if (capture)`. Out-of-scope callers pass nothing and execute nothing.

**`RerankDeps.judgeFn` widens to `(q, c, capture?)`**, matching `rerankJudge` directly.

**`RerankDeps.cohereFn` needs an adapter, not a widening**, because `rerankCohere`'s position 3 is `fetchImpl` and widening would pass the capture as `fetch`:

```ts
const cohereFn = deps.cohereFn ?? (<U extends RerankCandidate>(
  q: string, c: U[], cap?: TelemetryCapture,
) => rerankCohere(q, c, undefined, undefined, cap));
```

**The annotations are not optional.** `RerankDeps.cohereFn` is itself generic, `<U extends RerankCandidate>(q: string, c: U[]) => ...`, and an arrow on the right of `??` gets no contextual type from the left operand. Leave the parameters bare and `tsc --noEmit` fails with TS7006 under `strict`, which is gate command 2.

**Six call sites need an explicit placeholder** for an intervening optional parameter: `rerank(...)` in `lib/retrieve.ts` (add `undefined` for `deps`), `expandQuery(query)` in `lib/retrieve.ts` and `expandFn(question)` in `lib/multi-query.ts` (add `undefined` for `traceId`), `rerankFn(...)` in `lib/multi-query.ts` (add `undefined` for `deps`), `retrieveMultiQuery(...)` in `lib/mcp-tools.ts` (add `undefined` for `deps`), and the `cohereFn` adapter above.

### D5. Four types, in two modules, with exact fields.

```ts
// lib/retrieval-capture.ts. NEVER in lib/retrieval-telemetry-core.ts
type TelemetryCapture = {
  readonly role: RetrievalRole;
  expansion?: { status: ExpansionStatus; inputText: string; evidence: TransportEvidence | null };
  variantGeneration?: {
    status: VariantStatus; evidence: TransportEvidence | null;
    promptTokens: number | null; completionTokens: number | null; generatedCount: number;
  };
  variants?: Array<{ index: number; outcome: VariantOutcome; candidateCount: number }>;
  fusedCandidateIds: number[];
  hydratedCandidateIds: number[];
  passageTexts: string[];              // parallel to hydratedCandidateIds. RAW. Never leaves this object.
  orderedFinalCandidateIds: number[];
  intendedBackend: string;
  intendedModel: string;
  servedBackend: string | null;        // what actually ran. Null only if no request was made.
  rerankBackendDowngraded: boolean;    // the Cohere-to-judge fall-through in D16
  expectedBatchCount: number;          // derived from servedBackend, never from intendedBackend
  batches: Array<{
    index: number; start: number; end: number;
    evidence: TransportEvidence | null; outcome: BatchOutcome;
    expectedScoreKeys: number; finiteScoreKeys: number;
    promptTokens: number | null; completionTokens: number | null;
  }>;
  rerankSoftFailed: boolean;
  retrievalOutcome: 'success' | 'zero_hits' | 'retrieval_failure';
  retrievalErrorClass: string | null;
  retrievalConfig: Record<string, string | number | boolean>;
  corpusVersion: string | null;
  indexVersion: string | null;
  children?: TelemetryCapture[];       // multi-query variant captures
};

createTelemetryCapture(role: RetrievalRole): TelemetryCapture

buildRetrievalPayload(
  capture: TelemetryCapture,
  opts: { hmacKey: string | null; scorerContext: string | null },
): RetrievalPayload

// lib/retrieval-telemetry-core.ts
type RetrievalPayload = { /* text-free. Every text is an HMAC or a count. */ };
type OperationalTelemetry = { /* route, role, invocation, timestamps, routing flags, backfill state */ };
type StampedRetrievalManifest = RetrievalPayload & { operational: OperationalTelemetry };
```

`scorerContext` is the exact rendered `citedContext`, supplied only for role `primary`. `hmacKey` null means the key is absent, which D8 handles.

**`TelemetryCapture` must not be declared in `lib/retrieval-telemetry-core.ts`.** That file's header states no clinical text reaches a field defined in it, and the existing privacy pin slices its source text.

**Rewrite the privacy pin.** Slice `RetrievalPayload` and `OperationalTelemetry` each by name, assert each slice is non-empty before testing it, keep the thirty-letter-run assertion, and add an assertion that `lib/retrieval-telemetry-core.ts` does not contain the string `TelemetryCapture`.

**`StampedRetrievalManifest` is a one-line intersection alias and has no field list to slice.** Do not pretend to scan it. Assert instead that it is exactly the intersection of the other two, so a field can never be smuggled in through the alias. That is a two-declaration ban loop plus one shape assertion, not three ban loops.

**When an injected test collaborator does not populate telemetry**, the capture keeps its defaults, `buildRetrievalPayload` records that stage's evidence as null, and validation treats it as "not collected" rather than a defect.

### D6. Scope, roles, and the multi-query contract.

| Site | Role | Route |
|---|---|---|
| `defaultRetrieve` in `lib/opd-note-audit.ts` | `primary` | from the caller |
| `normativeChannelRetrieve` in `lib/opd-note-audit.ts` | `normative_channel` | from the caller |
| `defaultRecall` semantic leg in `lib/lvc.ts` | `lvc_recall` | see D7 |
| `labRetrieve` direct branch in `lib/mcp-tools.ts` | `lab_direct` | `mcp_tools` |
| `labRetrieve` multi-query branch in `lib/mcp-tools.ts` | `lab_multi_query` | `mcp_tools` |

Every other caller of `retrieve()` passes no capture and is uninstrumented by construction.

**Dependency precedence never depends on capture.** Otherwise a telemetry-on ranking-invariance test would hit the real provider while telemetry-off ran a fake.

```ts
type MultiQueryDeps = {
  retrieveFn?: typeof retrieve;
  rerankFn?: typeof rerank;
  variantsFn?: (question: string) => Promise<string[]>;
  variantsWithTelemetryFn?: (question: string) => Promise<VariantGenerationResult>;
  expandFn?: typeof expandQuery;
};
```

Resolution order, identical with or without a capture: `deps.variantsWithTelemetryFn`, then `deps.variantsFn`, then `generateQueryVariantsWithTelemetry`. A legacy injection is never bypassed.

**A legacy `deps.variantsFn` returning `[]` is not classifiable, and must not be guessed.** From an array alone you cannot tell `parsed_empty` from `failed_open`. So for that seam: use the output, record evidence as null, and record the status as `not_collected` rather than deriving one. `not_collected` is a seventh status value, it means the seam cannot report, and it never makes a row partial. Do not infer `parsed_empty` from an empty array.

**Multi-query manifest section, six real statuses plus `not_collected` for the legacy seam:**

```text
multi_query: {
  variant_generation: {
    status: 'generated' | 'parsed_empty' | 'all_invalid' | 'not_an_array'
          | 'parse_failure' | 'failed_open' | 'not_collected';
    served_route_class: ServedRouteClass;
    served_model: string | null;
    attempts: AttemptSummary[] | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    generated_variant_count: number;
  };
  variants: Array<{
    index: number;            // 0 is the ORIGINAL expanded arm
    outcome: 'success' | 'zero_hits' | 'retrieval_failure';
    candidate_count: number;  // equals perVariantCounts[index]
  }>;
}
```

`not_an_array` is valid JSON that is not an array, which the current code folds into the empty return. `variants.length` equals `generated_variant_count + 1`.

`generateQueryVariants(question): Promise<string[]>` keeps its exact signature and delegates to `generateQueryVariantsWithTelemetry`. Do not copy its body.

**The wrapper must contain the literal `return [];`.** `lib/__tests__/retrieval-llm-determinism.test.ts` line 34 greps `lib/multi-query.ts` for that exact string. Write the wrapper so its fail-open branch spells it out:

```ts
export async function generateQueryVariants(question: string): Promise<string[]> {
  const result = await generateQueryVariantsWithTelemetry(question);
  if (result.status !== 'generated') return [];
  return result.variants;
}
```

That is not a formality. The string and the behaviour it stands for must both survive.

### D7. `lvc_recall` gets a real seam.

`MatchInput` has no telemetry field and `defaultRecall` is the shared default, so automatic instrumentation would also instrument the probe scripts, and opt-in with no seam would leave the appropriateness route uninstrumented. Add:

```ts
telemetry?: { ctx: TelemetryRequestContext; route: RetrievalRoute };
```

`defaultRecall` creates a capture only when `input.telemetry` is present.

```text
A/A route, pass using default recall   telemetry set, route 'lvc_judge_aa', capture on
A/A route, pass using pinned recall    telemetry absent, capture off. A pinned recall performs
                                       no semantic retrieval, so it must not declare.
Appropriateness request                telemetry set, route 'unknown_route', capture on
Right-care probe scripts               telemetry absent, capture off, nothing written
```

**`app/api/appropriateness/route.ts` is authorized for telemetry-context wiring only.** Add the request context and the `telemetry` field to the `matchLowValueCare` call. Change nothing else in that file.

Invocation ids are per request or per operation. Never one module-level process id.

### D8. HMACs at the caller. Explicit nulls when the key is absent.

No HMAC is computed inside `retrieve()`, which serves out-of-scope surfaces. The capture holds raw bytes. Every HMAC is computed in `buildRetrievalPayload`.

**When the key is absent**, which can only happen outside production, nothing throws. Write **explicit nulls, never omitted fields**: `hmac_key_version`, `expansion.input_hmac`, `pre_rerank_passage_hmacs`, `scorer_context_hmac`, plus `telemetry_error = 'hmac_key_absent'`. The validator accepts null for exactly those four when and only when that error is set.

**The terminal state is role-sensitive.** A persisting role settles `persisted_partial`. A non-persisting role settles `no_persistence_intended`. A missing key must never turn a non-persisting run into a persisted state.

**The build assertion lives in `lib/telemetry-key-guard.ts`**, not `.mjs`, because a `.mjs` under `lib/` fails `tsc --noEmit` with TS7016 when a test imports it.

```ts
export function telemetryKeyMissingInProduction(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === '1' && env.VERCEL_ENV === 'production'
    && !String(env.CDMSS_TELEMETRY_HMAC_KEY ?? '').trim();
}
```

`next.config.mjs` cannot import a `.ts`, so it **inlines the same three-line condition** and throws. Add a source pin asserting the two express the same three clauses. `next.config.mjs` is three lines today and has no `buildCommand`; `buildCommand` lives in `vercel.json` and is on the do-not-touch list.

**The HMAC must not be reproducible with an unkeyed hash.** Test that a plain SHA-256 of the same bytes does not reproduce a stored value, and that the output changes with the key version.

### D9. Fourteen states, the outcome-to-state table, every owner.

Non-terminal, two: `started`, `retrieval_complete`.

Terminal, twelve: `persisted_complete`, `persisted_partial`, `completed_unpersisted`, `persistence_refused`, `audit_persistence_failed`, `audit_generation_failed`, `telemetry_persistence_failed`, `aborted`, `persistence_unknown`, `retrieval_not_run`, `no_persistence_intended`, `persistence_skipped`.

Fourteen in total. **`not_eligible` is removed** from `RETRIEVAL_PERSISTENCE_STATES` and the CHECK. It is in the committed vocabulary today.

**Outcome to state, complete:**

```text
persisted, validation clean   -> persisted_complete
persisted, validation dirty   -> persisted_partial
losing_conflict               -> completed_unpersisted
persistence_skipped           -> persistence_skipped
persistence_refused           -> persistence_refused
audit_persistence_failed      -> audit_persistence_failed
audit_generation_failed       -> audit_generation_failed
no_persistence_intended       -> no_persistence_intended
retrieval_not_run             -> retrieval_not_run
```

`aborted`, `persistence_unknown` and `telemetry_persistence_failed` are reachable **only** by the reconciler. No settlement outcome produces them.

**Correct the committed comment on `audit_persistence_failed`.** It says today that the audit write failed "or lost its ON CONFLICT race". This table sends `losing_conflict` to `completed_unpersisted`, so the second half of that sentence becomes false. Fix the comment text. Change nothing about the state itself, and put the old and new text in the report.

A successful callback settles every `retrieval_complete` role exactly once with the same audit id. **A role still at revision 0 because its terminal write failed is not linked**, and is settled from the failure evidence.

**Owner matrix, every path:**

`saveOpdAudit` returns one of four values, `inserted`, `updated`, `exists` and `skipped`. **`skipped` is reachable**: it is the no-uid branch. It settles `persistence_skipped`. Every owner below covers all four.

```text
worker, day and sweep       inserted/updated -> onPersisted settles
                            exists -> caller settles losing_conflict
                            skipped -> caller settles persistence_skipped
                            DEC-2 refusal -> caller settles persistence_refused
                            throw after adoption -> audit_generation_failed
                            throw before adoption -> retrieval_not_run
worker, re-audit            identical
run route GET, force arm    .catch(() => 'save_failed') means the throw never reaches the caller,
                            so THAT arm settles audit_persistence_failed itself
run route GET, normal arm   as the worker
run route POST              audits and never saves -> no_persistence_intended
mini-backfill               as the worker. DEC-2 throw -> persistence_refused
mcp-tools mini_analyze      writes lab_analyses only -> no_persistence_intended
mcp-tools backfillControl   as the worker
lab-batch normal completion lab store only -> no_persistence_intended
lab-batch refusal branch    no_persistence_intended
bedrock probe script        as the worker. Its own save failure -> audit_persistence_failed
metamorphic script          audits and saves nothing -> no_persistence_intended
labRetrieve, both branches  no audit -> no_persistence_intended
defaultRecall               no audit -> no_persistence_intended
```

Assert exactly-once directly. Do not let an idempotent no-op hide a double settlement.

### D10. The worker declaration, and the 503.

**Single-day and sweep.** `processDay` fetches its note set before `mapLimit`. Immediately before `mapLimit`: generate a run id and role `primary` per note, insert all in one batch as `started`, and on failure throw `TelemetryDeclarationError` and process no notes of that day.

**Sweep persists across days.** A declaration failure on the second or later day returns 503 **after** earlier days' notes were audited and persisted. "No notes are processed" is true per day, not per request. Say so in the 503 body and the report.

**Re-audit, reshaped.** The uid list is unvalidated input, each note is fetched inside `mapLimit`, and the per-uid catch converts every throw into a 200.

```text
1. Fetch every uid's row first, outside mapLimit. Keep a resolved list and an unresolved list.
2. Declare rows for the resolved list only, in one batch, outside mapLimit.
3. Wrap steps 1 and 2 in a NEW OUTER try that returns 503 on TelemetryDeclarationError.
4. Run mapLimit over the resolved list. The existing per-uid catch stays exactly as it is.
5. Re-insert the unresolved uids into results as { uid, error: 'note not found in db13' },
   preserving today's output, and keep count: uids.length. mapLimit preserves input order and
   the 25-uid slice is upstream of the fetch, so both survive.
```

Predeclaring per uid before the fetch would insert `started` rows for uids that do not exist, each becoming a permanent `aborted` row that never had a retrieval to abort.

```ts
class TelemetryDeclarationError extends Error {}
```

Single-day and sweep need a typed branch in their existing route-level catch so this returns 503 rather than 500.

**`app_source` is passed explicitly and the stamper is not used.** Do not add the new tables to `STAMP_TABLES`. Bind `process.env.APP_SOURCE || 'standalone'`, which is the idiom `lib/db.ts` line 7 already uses. **Never bind `process.env.APP_SOURCE` bare.** It is `string | undefined`, the column is `NOT NULL`, and a bound `undefined` reaches Postgres as NULL and fails the insert rather than falling back to the column default. The default is documentation and a second line of defence for hand-written SQL, not a rescue for a bound null. Test the multi-row insert shape by name.

**Predeclared run ids are threaded in, never reallocated.**

```ts
type PredeclaredTelemetryRuns = {
  primary: { runId: string; expectedRevision: 0 };
  normativeChannel?: { runId: string; expectedRevision: 0 };
};
```

On `AuditOpdOpts`. Reuse these exact ids, never allocate a replacement, never insert a second `started` row. When supplied, `auditOpdNote` adopts rather than declaring, and still publishes the handle.

**`trace_id` is a mutable field, written at the `retrieval_complete` write**, because the worker declares before `startTrace` runs and `lib/mcp-tools.ts` passes `trace: false`.

### D11. Ordering, handle publication, and the primary terminal write.

**Non-worker fresh audit, inside `auditOpdNote`, in this exact order:**

```text
 1. pass the reuse guard
 2. startTrace, so traceId exists where it exists at all
 3. determine the expected role set from options
 4. create or adopt the invocation record
 5. declare the retrieval rows
 6. publish the handle                       <- before any fallible work
 7. capture the primary retrieval result in memory
 8. capture the normative result when enabled
 9. assembleAuditContext over both hit sets
10. compute the primary scorer-context HMAC
11. build both role payloads
12. write the primary terminal, publish the handle
13. write the normative terminal, publish the handle
14. continue audit generation
```

Steps 9 to 11 are why the primary terminal write cannot happen at step 7.

**Reuse audit:** return at step 1. No invocation row, no retrieval rows, no handle.

**Worker:** declares before `auditOpdNote` is entered, and adopts at step 5.

**Reconciler:** calls `startInvocation()` directly.

**Every handle update is published before the next fallible operation.**

```ts
onLifecycleHandleUpdated?: (handle: LifecycleHandle) => void;
```

It fires after declaration and after every successful transition. `auditOpdNote` can throw after declaration, after either retrieval, during context assembly, or during audit generation, so returning the handle only on the audit object would leave the caller with nothing after a throw. The non-enumerable property on the audit object stays for the success path.

**A throw after declaration and before any save settles `audit_generation_failed`**, not `audit_persistence_failed`, because `saveOpdAudit` was never called.

**Order and asymmetry**, because the driver has no cross-statement transaction. The invocation insert is fail-open even on the worker. The worker's retrieval-row batch is fail-closed and is the only fail-closed operation. `declared_retrievals` counts newly inserted run ids only.

Boundaries that create a request context: `app/api/opd-audit/worker/route.ts`, `app/api/opd-audit/run/route.ts`, `app/api/admin/opd-audit-mini-backfill/route.ts`, `app/api/admin/lab-batch/route.ts`, `app/api/admin/lvc-judge-aa/route.ts`, `app/api/appropriateness/route.ts` (wiring only), `app/api/mcp/route.ts`, `app/api/mcp/[key]/route.ts`, and one per process in `scripts/bedrock-opd-note-probe.mjs` and `scripts/metamorphic-llm-report.mjs`.

`batchTick()` accepts the typed context and never creates its own. `dispatchMcp(body)` takes only the body, so thread the context through `lib/mcp-server.ts`.

`AuditOpdOpts.telemetry` is optional. Absence records `unknown_route`, a canary defect for every row except `lvc_recall` rows on the appropriateness route.

Absent `x-vercel-id`: omit the key. `routing_flags` stays `Record<string, string>`.

### D12. Revisions, transitions, canonicalization.

```ts
declareRetrievals(ctx, runs): Promise<LifecycleHandle>
writeRetrievalTerminal(handle, role, payload): Promise<LifecycleHandle>
settleRetrievalTelemetry(handle, outcome): Promise<PerRunSettlementResult[]>

type LifecycleHandle = {
  invocationId: string;
  runs: { role: RetrievalRole; runId: string; expectedRevision: number }[];
  persistenceIntent: 'will_persist' | 'never_persists';
};

type PerRunSettlementResult = {
  role: RetrievalRole; runId: string;
  status: 'settled' | 'failed'; errorClass?: string;
};
```

Every write returns an updated handle. Nothing mutates in place. Revisions advance per role, independently.

`settleRetrievalTelemetry` isolates each run. If primary settles and normative fails, it returns one `settled` and one `failed`, writes a `persistence_link` failure row for the failed run, and **does not throw**. `telemetry_link_failed` is deliberately not a settlement outcome.

**The failure store is the last line, and it is fail-open.** Every write to `opd_retrieval_telemetry_failures` is wrapped so its own exception cannot propagate. When it throws, do two things and nothing else: log, and increment `telemetry_write_failures` on the invocation row. **That column is the counter, and this is its only writer.** If that increment also throws, log and continue. **Do not hold a counter in module state.** PRD section 4.1 forbids mutable process-global state, and a per-process number would not survive the invocation anyway. The honest record is the invocation row or nothing.

`saveOpdAudit` never receives the handle. It receives only `onPersisted?: (result: { status: 'inserted' | 'updated'; auditId: string }) => Promise<void>`. The closure holds the handle. A callback exception is swallowed and the save result preserved.

Allowed transitions, and only these:

```text
started -> retrieval_complete | aborted | retrieval_not_run | telemetry_persistence_failed
         | audit_generation_failed

retrieval_complete -> persisted_complete | persisted_partial | completed_unpersisted
                    | persistence_refused | audit_persistence_failed | audit_generation_failed
                    | persistence_skipped | no_persistence_intended
                    | telemetry_persistence_failed | persistence_unknown
```

Terminal states never transition. `retrieval_complete -> aborted` is deliberately absent.

**`started -> audit_generation_failed` is deliberately present.** D11 puts the primary terminal write at step 12, and `auditOpdNote` can throw at steps 7, 8 or 9. A row that has not reached its terminal write is still `started` when the audit fails, so forbidding this transition would leave the only honest settlement unreachable and hand the row to the reconciler as an `aborted` guess. The row's `retrieval_outcome` is null on this path, which is why the outcome CHECK permits either for that state.

**Update precedence, exactly this order.** First the identical-content no-op check, which does not increment `row_revision`. Then expected-revision validation, rejected and logged on mismatch, never retried blindly. Then the transition check. Then apply and increment.

**Canonicalization, one function.** Keys sorted recursively at every depth. Array order preserved. `undefined` omitted in objects and rejected in arrays. Non-finite numbers rejected. Comparison against the normalized JSON used for persistence, after a JSONB round trip.

**Derive the equality projection from the final DDL.** Classify every column as immutable insert, mutable terminal, revision metadata or derived, and put that table in the report. Manifest operational timestamps are excluded from the comparison, and a retry reuses the originally stamped manifest.

### D13. Reconciliation.

| Row state at deadline | Run-level failure evidence | Assigned state |
|---|---|---|
| `started` | `retrieval_terminal` failure | `telemetry_persistence_failed` |
| `started` | none | `aborted` |
| `retrieval_complete` | `persistence_link` failure | `telemetry_persistence_failed` |
| `retrieval_complete` | none | `persistence_unknown` |

A `work_declaration` failure produces no retrieval row and has no mapping. Its evidence lives only in the failure table.

```text
A successful terminal state always wins over earlier failure evidence.
Failure rows are historical and are never deleted or consumed.
Reconciler updates carry an expected row_revision.
A revision mismatch causes a reread and reclassification, never a blind retry.
The reconciler never transitions an already terminal row.
Where several failures exist, the latest phase relevant to the current row state controls.
```

The reconciler must not join `(uid, engine_version)` to find an audit.

**The grace period is preregistered.** `WORKER_MAX_DURATION_SECONDS + 1800`, fixed in `lib/opd-audit-runtime-config.ts` and recorded in the report **before** any canary opens. It cannot be tuned afterwards to make a gate pass. Changing it restarts the window.

The constant does not exist yet. Create it with the value 800, matching the worker route literal, and pin the two together by source text.

**Say plainly in the report that this grace is conservative for most rows.** 800 is the highest `maxDuration` among the instrumented routes; the 300-second routes' rows therefore wait far longer than those routes could possibly run before the reconciler touches them. One grace for every row is the deliberate choice, because a per-route grace is a tuning surface and this one must not be. State the trade, do not hide it.

The reconciler cron is `1 10 * * *` UTC, clear of the worker window and off the even minute, using the `x-vercel-cron` guard the worker route uses. Its runs go in the invocation table with `kind = 'reconciler'`, `route = 'reconciler'`.

### D14. Failure attribution, additive, traceless arm only.

**Unchanged:** the field names of `CdmssTransportAttribution`, the behaviour of its two helpers, the existing property name and descriptor, the existing `lib/trace.ts` re-exports, and every existing consumer and test. That does not forbid widening `TransportAttempt.tier`.

**Added:**

```ts
type CdmssTransportFailureAttribution = {
  outcome: 'failed';
  servedProvider: null;
  servedModel: null;
  attempts: TransportAttempt[] | null;
  terminalPhase: string;
};
```

Its own property name, its own immutable helper (`writable: false, configurable: false`, in a try/catch), its own reader. `lib/trace.ts` is authorized for the new re-exports and nothing else.

**Scope: the traceless arm in `lib/llm.ts` only.** `tracedChat` also makes real local requests with no attempts array, but the retrieval path never reaches it, because `rerankJudge` and `expandQuery` both pass `traceId` undefined. Fixing `tracedChat` goes in the defect list.

**`TransportAttempt.tier` gains `'ollama'`**, with its comment changed to say it names the provider attempted.

**Record an Ollama attempt for every actual local request on that arm.** The intended-local path reports `attempts: []` while making a real call. Fix that, and wrap the terminal local fallback so a throwing Ollama call records its attempt and reaches the thrown error with failure attribution. Change nothing about which errors are thrown or when.

`lib/expand.ts` catches without binding the error. Bind it.

### D15. The attempt taxonomy, the batch outcomes, and the two orphan counters.

**Carry the committed attempt taxonomy into the manifest unchanged.** `TransportAttemptOutcome` already has `http_429`, `http_other`, `timeout`, `transport_error`, `bad_response`, `success`. Every manifest attempt records one of the six. Nothing here is invented.

**`classifyAttemptOutcome` produces five of the six.** It is only reached on a failure and never returns `success`; success attempts are pushed at the call sites. So an instrumented path that only funnels through the classifier records failures and loses every success attempt. Capture both. Do not add `success` to the classifier.

**`BatchOutcome` gains `timeout`.** PRD section 6.2 requires terminal failure, timeout, parse failure, missing score key and nonnumeric score to be distinct outcomes. Precedence, highest first:

```text
timeout            the terminal attempt's outcome was 'timeout'
terminal_failure   attempts exhausted for another reason
parse_failure
missing_score_key
nonnumeric_score
success
```

Independent counts are preserved alongside, so a response with both missing and non-numeric keys records both facts and one outcome.

**Wire the two orphan counters, and fix the function that feeds them.** Both columns exist in 0035 and no earlier version of this kickoff gave either a writer, so both would have stayed at zero.

```text
rerank_429_attempts         = batchCounters().retries_429
rerank_unattributed_batches = batchCounters().unattributed
rerank_not_served_batches   = batchCounters().not_served
```

**`batchCounters()` needs a change before any of that is honest.** Its class attribution ends in a bare `else` that increments `unattributed`. Once `not_served` exists, and once a skipped stage carries a null class, both land in that `else` and are reported as unattributed. Two different facts merged into one column is exactly what PRD section 2 forbids.

```ts
if (b.served_route_class === 'vertex') c.vertex += 1;
else if (b.served_route_class === 'openrouter') c.openrouter += 1;
else if (b.served_route_class === 'local') c.local += 1;
else if (b.served_route_class === 'not_served') c.not_served += 1;
else if (b.served_route_class === 'unattributed') c.unattributed += 1;
// a null or absent class increments nothing
```

**Three edits, not one.** The function has an explicit return-type annotation and a separate initialiser, each listing the six fields by name. This is what the tree holds today, at lines 247 to 250:

```ts
export function batchCounters(m: RetrievalManifest): {
  vertex: number; openrouter: number; local: number; failed: number; unattributed: number; retries_429: number;
} {
  const c = { vertex: 0, openrouter: 0, local: 0, failed: 0, unattributed: 0, retries_429: 0 };
```

Add `not_served` to the annotation, to the initialiser, and to the branch chain. Missing any one of the three fails `tsc`. **Keep the parameter's type name in step with step 4**: step 4 replaces `RetrievalManifest` with the two new manifest types, so this signature moves with it. Do not leave a reference to a type that no longer exists.

**This breaks a whole-object equality test that the file contract does not otherwise name.** `lib/__tests__/retrieval-telemetry-core.test.ts` line 152 asserts `deepEqual` against the exact six-field object. Add the seventh field to that expectation. It is authorized, for that field only.

Test each of the five classes and null separately. `rerank_429_attempts` is the 429 count. It is the number this workstream exists to produce.

### D16. Roles, the `not_served` mapping, and the architecture trap.

`retrieval_role` values: `primary`, `normative_channel`, `lvc_recall`, `lab_direct`, `lab_multi_query`, with a CHECK generated from a `RETRIEVAL_ROLES` const. One manifest location: `operational.retrieval_role`.

**`ServedRouteClass` gains `not_served`.** `unattributed` means a completion may have been served and attribution is unavailable. `not_served` means telemetry can prove no completion was served, and **requires failure attribution as that proof**. Without proof the answer is `unattributed`.

**Where the explicit null lives, and where it does not.** PRD section 7, amended, counts an explicit null as a declaration where the stage made no request. That null belongs at **stage** level: `expansion.served_route_class`, the variant-generation status block, and the rerank stage attribution. It never appears on a **batch** record, because a batch record exists only where a request was planned. So the type permits null on a batch and `batchCounters()` must count it as nothing, while `validateManifest` requires non-null on every batch it sees, per D17. Those two rules do not conflict: the type is defensive, the validator is the contract. Say both in the report so nobody later reads the counter branch as permission.

**The stage mapping table. This is the contract.**

```text
Provider success                    route counter for vertex/openrouter/local += 1
                                    failed unchanged, served_route_class = that provider

Terminal failure PROVEN to have     not_served += 1, failed += 1
returned no completion              served_route_class 'not_served', served_model null

Completion may have arrived,         unattributed += 1 (into rerank_unattributed_batches)
attribution unavailable              failed follows the batch outcome
                                     served_route_class 'unattributed'

Timeout                              the attempt records outcome 'timeout'; the batch outcome is
                                     'timeout'; served class follows the proof rule above

Stage skipped, no request made        no route counter, no not_served counter, attempts = []
                                     served_route_class null, NOT 'not_served'

Cohere entered and soft-failed        one synthesised batch record per planned boundary,
                                      each outcome 'terminal_failure',
                                      served_route_class 'not_served',
                                      rerank_not_served_batches += that count,
                                      rerank_soft_failed = true

Intended local request                exactly one ollama attempt, success or failure
                                      'local' on success, 'not_served' on proven failure

Variant parse_failure                 served provider, model, attempts and token usage are
                                      PRESERVED. A completion arrived and did not parse.
                                      status 'parse_failure'. Never 'not_served'.

Variant parsed_empty / all_invalid     served provider, model and usage preserved.
/ not_an_array

Variant failed_open                   'not_served' only with failure attribution proving no
                                      completion arrived, otherwise 'unattributed'
```

**Malformed served output still counts as provider usage and cost.** A parse failure consumed tokens.

**`rerank_soft_failed` does not waive batch reconciliation.** Synthesise one `terminal_failure` record per planned boundary so expected equals recorded. The batch-count check is never waived. `rerank_soft_failed` describes degraded ranking, not missing evidence.

**Bedrock, defensively.** If a Bedrock completion appears on this path, record `unattributed` **and** write a failure row with a distinct error class marking a hard telemetry defect.

**Judge batch count.** `expected_batch_count = ceil(retained_pool / JUDGE_BATCH)`, using the existing constant in place. Cohere is one request, one batch, count 1.

**There is a third case, and it is the one that would have failed the gate silently.** `lib/rerank.ts` lines 238 to 249: when Cohere is the backend by environment default rather than an explicit request, an unhealthy Cohere raises `RerankBackendError` and the code **falls through to the judge**. Intended backend Cohere gives expected 1; the judge then serves N batches. PRD section 7 says expected and recorded must reconcile and is never waived, so every row on that path would be `persisted_partial` by construction. Since section 2 records that we do not know whether `RERANK_BACKEND` is set for Preview, this is exactly a canary-era path.

**The fix, and it is a requirement not a suggestion.** `expected_batch_count` is stamped **after backend resolution, from the backend that actually served**. Record the downgrade as its own fact rather than hiding it in the counts:

```text
intended_backend             what the configuration asked for. Cohere on this path.
served_backend               what ran. The judge on this path. Never null once a request was made.
rerank_backend_downgraded    true only on this fall-through
expected_batch_count         computed from served_backend
```

`served_backend` and `rerank_backend_downgraded` are new manifest fields and new columns. A downgraded row reconciles and is `persisted_complete` if nothing else is wrong. Test the fall-through end to end: unhealthy Cohere by default, judge serves, expected equals recorded, the downgrade flag set, the row not partial.

**`JUDGE_BATCH` is module-private in `lib/rerank.ts` and is on the do-not-touch list.** Do not export it, and do not import it into a test. The test for this reads the value out of the source text of `lib/rerank.ts` and computes the expected count from what it read. That keeps the test honest if the constant ever changes, and keeps the constant untouched. Say in the report that the test reads source text and why.

**The architecture trap.** Register every new `lib/*.ts` exporting a `*_VERSION` const in `MODULE_MANIFESTS` or `UNREGISTERED`, or `architecture:check` fails with no explanation. `.mjs` files are never scanned.

### D17. Validation, edge cases, and the scorer-context HMAC.

Add **`InvocationRoute`**, which is `RetrievalRoute` plus `reconciler`, used only by the invocation table.

```text
persisted_complete:  audit written, audit_id linked, validateManifest returned [], every
                     required field present, expected_batch_count equals recorded_rerank_batches.
                     A recorded retrieval_failure does not prevent this.

persisted_partial:   audit written and linked, and at least one of: a non-empty validateManifest
                     result, a required field absent, or a batch-count mismatch.
```

**`validateManifest` takes `unknown`** and validates at run time. Own-property checks distinguish missing field, explicit null, empty array, empty string and invalid number. Every violation gets a stable code. One absent-or-invalid test per required property.

Required fields, and whether explicit null is permitted:

```text
manifest_schema_version                        null NOT permitted
hmac_key_version                               null only with 'hmac_key_absent'
operational.route, route_class, retrieval_role  null NOT permitted
operational.started_at                         null NOT permitted
operational.completed_at                       null NOT permitted at terminal
operational.invocation_id                      null NOT permitted
operational.trace_id                           null permitted
operational.deployment_sha                     null permitted
operational.routing_flags                      null NOT permitted, {} permitted
operational.active_backfill_run_id             null permitted
operational.active_backfill_target             null permitted
operational.active_backfill_state              null permitted, 'active' or 'idle' otherwise
operational.active_lab_experiment_id           null permitted
retrieval_outcome                              null NOT permitted in the manifest
retrieval_error_class                          null permitted, required when outcome is failure
expansion.status                               null NOT permitted
expansion.input_hmac                           null with 'hmac_key_absent', or status 'skipped'
expansion.served_route_class                   null permitted when status is 'skipped',
                                               otherwise NOT permitted
expansion.served_model                         null permitted
expansion.attempts                             null permitted, meaning not collected
intended_backend, intended_model               null NOT permitted, 'none' permitted
served_backend                                 null permitted only when no request was made,
                                               NOT permitted once a rerank request was made
rerank_backend_downgraded                      null NOT permitted
retrieval_config                               null NOT permitted, {} permitted
corpus_version                                 null permitted
index_version                                  null NOT permitted
fused_candidate_ids                            null NOT permitted, [] permitted
hydrated_candidate_ids                         null NOT permitted, [] permitted
pre_rerank_passage_hmacs                       null only with 'hmac_key_absent', otherwise
                                               cardinality equals hydrated_candidate_ids
fused_candidate_count, hydrated_candidate_count null NOT permitted, finite and >= 0
expected_batch_count, recorded_rerank_batches   null NOT permitted
rerank_soft_failed                             null NOT permitted
ordered_final_candidate_ids                    null NOT permitted, [] permitted
scorer_context_hmac                            role-sensitive, see below
batches                                        null NOT permitted, [] permitted
per batch: index, start, end, intended provider
  and model, served_route_class, outcome,
  expected_score_keys, finite_score_keys       null NOT permitted
per batch: served_model, attempts,
  prompt_tokens, completion_tokens             null permitted
multi_query                                    required when role is 'lab_multi_query'
```

`expansion.served_route_class` accepting null on `skipped` is what stops every `normative_channel` row being partial by construction, since its options set `skipExpand` unconditionally.

**Two candidate counts, not one.** `fused_candidate_count` is the pool after the cap. `hydrated_candidate_count` is the rows the re-read returned, which is the number the rerank guard tests. Recording both makes a dropped row observable. `pre_rerank_passage_hmacs` has one entry per hydrated row.

**The scorer-context HMAC, by role.**

```text
primary            required. Keyed HMAC of the exact rendered citedContext bytes returned by
                   assembleAuditContext, computed at the caller after that call. With one
                   candidate the context is non-empty. With zero candidates it is the empty
                   string, and the HMAC of the empty string is a defined value. Never null
                   because reranking was skipped or failed.
normative_channel  null. The combined-context HMAC lives on the primary row.
lvc_recall         null, not applicable.
lab_direct         null, not applicable.
lab_multi_query    null, not applicable.
```

A null on the four non-primary roles never makes a row partial.

**Four edge cases, all synthesised by the payload builder. None is `unattributed`.**

```text
empty fusion         retrieve() returns before the rerank block exists.
                     fused 0, hydrated 0, expected 0, recorded 0, batches [], rerank
                     attribution omitted, intended backend and model 'none'.

hydrate emptied      fused > 0, hydrated 0. Reaches the rerank guard and falls through.
                     Same shape, and the two counts differ, which is the point.

one hydrated candidate  retrieve() never enters rerank(), which guards on hits.length > 1.
                     hydrated 1, expected 0, recorded 0, batches [], backend and model 'none'.
                     Do not expect rerank_backend 'none' on the hits.

reranker disabled    normative_channel always, lab_direct when the caller sets it.
                     Same shape as the one-candidate case.
```

The Cohere soft-failure case is not an edge case of this kind. It has real planned batches and D16 requires one synthesised record per boundary.

### D18. The five overhead numbers are measured, not left blank.

**The five are PRD section 6.5's five, not a list of your own.** They are start-write latency, terminal-write latency, manifest size, retrieval wall time and audit completion rate. V sets the thresholds and cannot set them against nothing. **Measure all five and put the numbers in the report.** An earlier version of this kickoff substituted a different five and would have left manifest size and audit completion rate measured by nobody.

```text
1. Start-write latency        the declaration insert, per note, on the worker's batch
2. Terminal-write latency     per role
3. Manifest size              serialized bytes of the stamped manifest, per role
4. Retrieval wall time        instrumentation on versus off, same injected collaborators
5. Audit completion rate      audits that complete, instrumentation on versus off
```

**Measure three more, reported separately and not as part of the five:** settlement write latency per role, the `activeRun('opd')` cost both cold and warm, and the sum of all added writes per audited note.

**Every number is synthetic and must be labelled synthetic in the report.** Measure against a local or test database with a stubbed clock where the harness allows it, state the method for each, and state plainly that a synthetic number is a floor and not a prediction of production. Do not run anything against the production database. Do not deploy to measure.

Report the distribution, not a single mean: minimum, median, maximum, and the sample size. A mean hides the tail, and the tail is what perturbs a throttling boundary.

**Do not propose thresholds.** V judges the start-write latency against the throttling behaviour it could perturb, not against a generic budget. Your job is the measurement and the method.

---

## 4. File contract

### Create

`lib/retrieval-capture.ts` · `lib/retrieval-telemetry-store.ts` · `lib/retrieval-invocation-store.ts` · `lib/retrieval-telemetry-failure-store.ts` · `lib/retrieval-settlement.ts` · `lib/opd-audit-runtime-config.ts` · `lib/telemetry-key-guard.ts` · `app/api/admin/migrate-retrieval-telemetry/route.ts` · `app/api/admin/retrieval-telemetry-reconcile/route.ts` · tests, all under `lib/__tests__/`: `retrieval-capture-payload`, `retrieval-telemetry-optin`, `retrieval-telemetry-lifecycle`, `retrieval-telemetry-transitions`, `retrieval-telemetry-canonicalization`, `retrieval-telemetry-validation`, `retrieval-ranking-invariance`, `retrieval-invocation-store`, `retrieval-settlement`, `transport-failure-attribution`, `telemetry-key-guard`, `multi-query-telemetry`, `worker-work-declaration`, `reconciler-races`, `retrieval-outcome-discrimination`, `rerank-soft-failure`, `migrate-retrieval-telemetry-parity`, `telemetry-non-exposure`, `attempt-taxonomy`.

### Edit

`migrations/0035_opd_audit_retrieval_telemetry.sql` (documentation, mirroring the route) · `lib/retrieval-telemetry-core.ts` · `lib/transport-attribution-core.ts` · `lib/llm.ts` · `lib/trace.ts` (new error-attribution re-exports only) · `lib/retrieve.ts` · `lib/rerank.ts` · `lib/expand.ts` · `lib/multi-query.ts` · `lib/opd-note-audit.ts` · `lib/opd-audit-store.ts` · `lib/lvc.ts` (the `MatchInput.telemetry` seam and `defaultRecall` only) · `lib/lab-batch.ts` · `lib/mcp-tools.ts` · `lib/mcp-server.ts` · `app/api/mcp/route.ts` · `app/api/mcp/[key]/route.ts` · `app/api/opd-audit/worker/route.ts` · `app/api/opd-audit/run/route.ts` · `app/api/admin/opd-audit-mini-backfill/route.ts` · `app/api/admin/lab-batch/route.ts` · `app/api/admin/lvc-judge-aa/route.ts` · **`app/api/appropriateness/route.ts`, telemetry-context wiring only** · `scripts/bedrock-opd-note-probe.mjs` · `scripts/metamorphic-llm-report.mjs` · `next.config.mjs` · `vercel.json` (reconciler cron entry only) · `.gitignore` (three allowlist lines only) · `lib/architecture/manifests.ts` and `map.generated.ts` · `.env.example`.

**Conditionally, and only if gate 7 demands it:** `data/reasoning-registry/prompts.generated.json`. Gate 7 runs `npm run reasoning:registry` and then `git diff --exit-code` on that file. If the generator rewrites it, the regenerated file is part of the commit; committing it is how that gate passes. Do not hand-edit it, and do not add or change a prompt to produce a diff. If the file changes, say in the report what changed and why a telemetry build touched the reasoning registry at all, because that is a result worth a second look.

`lib/db.ts` is not in the list. D10 removed the reason to touch it.

**`RERANK_BACKEND` and its resolution are on the do-not-touch list, and D16's downgrade fact does not change that.** You observe which backend served and record it. You do not alter the health check, the fall-through, or which backend wins.

**Existing tests explicitly authorized to change, with the reason each breaks:**

- `lib/__tests__/provider-switch-unit-d.test.ts`, **line 270 only**, and `lib/__tests__/ipd-worker-batch-and-model.test.ts`, **line 57 only**: both assert `vercel.json` has exactly 16 cron entries. The reconciler makes 17. Change the number and nothing else in either file. **In particular, leave `provider-switch-unit-d.test.ts` line 255 alone.** It is the test titled to forbid editing `lib/sql-guard-core.ts`, and D3 no longer asks you to.

- `lib/__tests__/retrieval-telemetry-core.test.ts`: hard-codes eight states, `started` as the only non-terminal state, six indexes at line 71, the old manifest type name, a CHECK slice whose `));` delimiter does not exist, and **a `deepEqual` at line 152 against the exact six-field `batchCounters()` object**, which the `not_served` counter breaks.
- `lib/__tests__/rerank-backend.test.ts`: source-pins the exact expression `defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend)`, which gains a capture argument. The most certain casualty in the build.
- `lib/__tests__/reasoning-enforcement.test.ts`, **only if your edits trip it, and only after you understand why.** Its `TAGGED_FILES` array at lines 25 to 31 holds fifteen paths, six of which are on your edit list: `lib/rerank.ts`, `lib/expand.ts`, `lib/lvc.ts`, `lib/mcp-tools.ts`, `lib/opd-note-audit.ts` and `app/api/appropriateness/route.ts`. The scan is at line 52, `text.matchAll(/'([a-z0-9-]+\/[A-Z][A-Z0-9_]+)'/g)`. **It has two failure modes, not one.** Every match must resolve to a registry id, so do not write a string literal of that shape: no `'telemetry/START_WRITE'`, no `'retrieval/PRIMARY_ROLE'`. And line 55 asserts every expected tag is still **present**, so do not delete or reshape an existing tag such as `'rerank/JUDGE_SYSTEM'` or `'expand/SYSTEM'` while editing around it. Avoiding the pattern is necessary and not sufficient. If the test fires, report it rather than editing it.
- `lib/__tests__/transport-attribution-traceless.test.ts`
- `lib/__tests__/gemini-openrouter-bridge.test.ts`: counts `dispatched_provider: 'ollama'` occurrences in `lib/llm.ts`.
- the existing multi-query expansion, fusion and bm25-attribution tests
- `lib/__tests__/normative-leg.test.ts`
- any other source-text pin your edits break.

### Do not touch

**The four files held uncommitted on `main`, and their parked branch.** PRD section 11.1 names them: `lib/lvc.ts`, `lib/opd-audit-changelog.ts`, `lib/__tests__/lvc-judge-attribution.test.ts`, `lib/__tests__/lvc-judge-pinning.test.ts`. The prohibition is on **those arm C changes**, which are parked at `park/lvc-arm-c-unshipped-11-aug-2026`. Do not merge that branch and do not read from it. `lib/lvc.ts` at `fc28e0f` is safe to edit for the one purpose in D7. **`lib/opd-audit-changelog.ts` and the two low-value-care test files are not edited at all.**

**`lib/sql-guard-core.ts`.** Its `BLOCKED_RELATIONS` literal stays byte-identical. Two committed tests assert it, `lib/__tests__/provider-switch-unit-d.test.ts` line 257 and `lib/__tests__/prognosis-outcomes-core.test.ts` line 341. Neither of those assertions changes.

Every migration except 0035 · any prompt, scoring rule, deterministic rule, suppression, formulary or low-value-care state · `JUDGE_BATCH`, `JUDGE_SYSTEM`, `JUDGE_MODEL`, `VARIANT_MODEL`, `SYSTEM_VARIANTS`, `RERANK_BACKEND` and its resolution · the retained-pool cap, pool sizing, RRF fusion, source weighting and the final slice in `lib/retrieve.ts` · the fusion and weighting logic in `lib/multi-query.ts` · `opdRetrieveOpts`, whose returned shape stays byte-identical · `RetrieveOptions`, which gains no telemetry field · the `generateQueryVariants` and `variantsFn` signatures · the external behaviour of the four swallowing sites, and of the re-audit results array · `vercel.json`'s `buildCommand`, `regions` and every existing cron schedule · any `maxDuration` or `runtime` **value** · `saveOpdAudit`'s return type · which errors `chatWithFallback` throws and when · `tracedChat`'s attribution · the field names of `CdmssTransportAttribution`, its two helpers' behaviour, and the existing property descriptor · `STAMP_TABLES` and `injectAppSource` · everything in `app/api/appropriateness/` except the single `matchLowValueCare` call and its request context.

---

## 5. Order of work

0. Preflight, then the preparatory commit.
1. Failure attribution, D14, additive, traceless arm only.
2. The migration route and its mirrored `.sql`, per D1 and D2, with the parity pin, the stop rule, and the three table comments.
3. The non-exposure test and the access statement, per D3. **No edit to `lib/sql-guard-core.ts`.**
4. Amend the core: two manifest types plus `OperationalTelemetry`, two route types, fourteen states with `not_eligible` removed, the corrected `audit_persistence_failed` comment, roles, `not_served`, `ollama` tier, `timeout` in `BatchOutcome`, the attempt taxonomy carried through, nullable attempts, the multi-query section, **and the `batchCounters()` branch fix with its `not_served` counter**. **The capture type does not go here.**
5. Rewrite the privacy pin and re-point the CHECK test, so neither can pass vacuously.
6. `validateManifest` on `unknown`, exhaustive, stable codes, the D17 null table.
7. Canonicalization and the transition guard.
8. `lib/retrieval-capture.ts`: the capture type with the D5 fields, `createTelemetryCapture`, `buildRetrievalPayload`, the four synthesised edge cases, and the two orphan counters wired from `batchCounters()`.
9. The trailing capture parameter at the six function positions in D4 plus the `MatchInput` field, the `cohereFn` adapter, the `rerankJudge` export, and the six placeholder call sites. Every telemetry statement guarded by `if (capture)`.
10. Instrument expansion, variant generation and rerank into the capture, including the Cohere soft-failure synthesis.
11. The discriminated retrieval outcome at all four swallowing sites, at both arms of `labRetrieve`'s existing catch, and before the throw from `defaultRecall`'s two outer `sql2` reads.
12. Multi-query instrumentation per D6, with capture-independent dependency precedence and the seven status values.
13. The `MatchInput.telemetry` seam per D7, and the appropriateness route wiring.
14. Invocation store, failure store, the two worker declaration shapes per D10, predeclared-run threading, `TelemetryDeclarationError`, 503 in all three modes with a new outer try for re-audit and the unresolved-uid rows preserved.
15. Telemetry store, lifecycle writes returning updated handles, `onLifecycleHandleUpdated`, HMACs at the caller, the handle as a non-enumerable property, and the D11 fourteen-step order.
16. `settleRetrievalTelemetry` per D12, `onPersisted` at the seven save expressions, and every owner in D9.
17. Reconciler, its cron, the D13 mapping and the preregistered grace.
18. Register every new `lib/*.ts` exporting a `*_VERSION` const.
19. Cost query text with provenance, and all ten PRD section 8 query texts.
20. Tests.
21. The five overhead measurements, synthetic, per D18.
22. Report.

Do not deploy. Do not target a canary.

Restated because it is the easiest thing to get wrong: the per-batch catch in `rerankJudge` leaves scores at their initialiser zero. A genuine zero and a failed batch are indistinguishable in the scores array. Your telemetry is the only thing that can separate them.

---

## 6. Tests

Everything in PRD sections 6.1 to 6.5, plus:

1. **Instrumentation off.** With no capture, no telemetry builder executes, no raw material is captured, no telemetry write happens, and the returned runtime shape is exactly today's. Assert for `retrieve`, `rerank`, `rerankJudge`, `rerankCohere`, `expandQuery` and `retrieveMultiQuery`.
2. The `cohereFn` adapter passes the capture as capture and not as `fetch`, and the Cohere path still works with an injected `fetchImpl`.
3. `TelemetryCapture` is absent from `lib/retrieval-telemetry-core.ts` by source assertion, and never reaches a store, a log or a serialized payload.
4. The rewritten privacy pin fails when a banned field is added to either of the two field-bearing declarations, cannot pass on an empty slice, and asserts `StampedRetrievalManifest` is exactly their intersection.
5. **Non-exposure.** A source-text search across `app/` and `lib/` finds no `SELECT` against the three tables outside D3's exact allow-list, which includes `migrations/0035_opd_audit_retrieval_telemetry.sql` and `lib/__tests__/retrieval-telemetry-core.test.ts`. The test states its own limit in a comment: it cannot see a dynamically composed name. **It asserts nothing about `lib/sql-guard-core.ts`**, whose two existing assertions stay exactly as they are.
6. **The HMAC cannot be reproduced with an unkeyed hash**, and its output changes with the key version.
7. The re-pointed CHECK test reads the `ADD CONSTRAINT` block and matches `RETRIEVAL_PERSISTENCE_STATES` exactly, at fourteen values, with `not_eligible` absent.
8. The migration route and the `.sql` agree, statement for statement and CHECK value for CHECK value, including the three table comments.
9. The migration route changes nothing and reports counts when the table exists with rows.
10. A `started` insert with `retrieval_outcome` null satisfies the outcome CHECK; a `retrieval_complete` row with it null violates it.
11. **The attempt taxonomy.** Every manifest attempt carries one of the six committed outcomes, and a timeout attempt is recorded as `timeout`, not folded into a transport error.
12. **`timeout` is a distinct batch outcome**, and the precedence in D15 holds when several defects coexist.
13. **`rerank_429_attempts` equals the count of `http_429` attempts, and `rerank_unattributed_batches` equals the unattributed batch count**, both taken from `batchCounters()`.
14. All four swallowing sites distinguish `success`, `zero_hits` and `retrieval_failure`. `labRetrieve` records `retrieval_failure` on both arms of its existing catch: a `RerankBackendError` still returns the same error result, and every other error still throws. `defaultRecall`'s two outer `sql2` reads record `retrieval_failure` and still throw. **Assert the external behaviour on each arm, not only the row**, and assert that the success path records `success` exactly once and not twice.
15. A `retrieval_failure` with a persisted audit settles `persisted_complete`, not partial.
16. **Cohere soft failure.** More than one candidate, Cohere selected, an untyped throw, `inputOrder()` returned, one synthesised `terminal_failure` batch per planned boundary, expected equals recorded, `rerank_soft_failed` true, and the row not partial.
17. The judge path cannot reach `inputOrder()`: a per-batch throw warns, continues, and leaves `rerank_soft_failed` false.
18. `expected_batch_count` equals `ceil(retained_pool / JUDGE_BATCH)` when the **judge served** and 1 when **Cohere served**. It is always derived from `served_backend`, never from `intended_backend`; test 70 covers the case where they differ. **The test reads `JUDGE_BATCH` out of the source text of `lib/rerank.ts`** and computes the expectation from what it read. It does not import the constant and does not hard-code its value.
19. Predeclared run id reused for every later update, no duplicate row inserted.
20. Revision advance: declare returns 0, terminal returns 1, a settlement using the stale handle is rejected, and revisions advance independently per role.
21. `onLifecycleHandleUpdated` fires after declaration and after each terminal write, and a throw at each of the five points in D11 leaves the caller holding the latest handle.
22. A throw after declaration and before any save settles `audit_generation_failed`, **from `started` when the throw beat the terminal write and from `retrieval_complete` when it did not**. Both are allowed transitions. The `started` case has a null `retrieval_outcome` and satisfies the outcome CHECK.
23. The D11 fourteen-step order: the primary terminal write happens after `assembleAuditContext`, never immediately after primary retrieval.
24. `trace_id` is null at declaration and written at the terminal write, and stays null for both retrieving `trace: false` callers, `lib/mcp-tools.ts` and `scripts/metamorphic-llm-report.mjs`.
25. Declaration failure returns 503 in single-day, sweep and re-audit modes, and no note of that day is processed.
26. Sweep that fails on a later day still returns 503, and the body says earlier days persisted.
27. Re-audit declares only for uids that resolve, outside `mapLimit`, keeps the unresolved uids as `'note not found in db13'` rows, and preserves `count: uids.length` and result ordering.
28. The multi-row declaration insert shape, with `app_source` present and no stamper involvement.
29. A failed batch declaration writes one failure row per generated run, and the failure-table CHECK rejects a null run id on those phases.
30. Invocation insert failure is fail-open and the retrieval proceeds.
31. Reuse-only work writes no invocation row and no retrieval row.
32. The handle is non-enumerable and absent from `JSON.stringify(audit)`.
33. Partial settlement: primary settles, normative fails, one `settled` and one `failed`, one failure row, nothing thrown. A role still at revision 0 is not treated as linked.
34. **Simultaneous terminal-write and failure-store failure.** The terminal write throws, the failure row also throws, and `telemetry_write_failures` on the invocation row is the only surviving evidence. Nothing propagates to the caller and the audit still completes. Then the case where that increment throws too: a log line and nothing else, and still no propagation. No module-level counter exists anywhere; assert that by source search.
35. Every row of the D16 stage mapping table, including `parse_failure` preserving provider, model, attempts and token usage, and `failed_open` mapping to `unattributed` without proof.
36. A Bedrock completion records `unattributed` plus a hard-defect failure row.
37. Success attribution backward compatibility: existing low-value-care consumers and tests unchanged, `tracedChat` untouched.
38. Local fallback attempted and failed records an `ollama` attempt. The intended-local path records one attempt rather than `[]`.
39. Variant generation across all six real statuses, plus `not_collected` on the legacy seam. `deps.variantsFn` is always used when supplied, with or without a capture, and its attribution is recorded as unavailable.
40. `generateQueryVariants` keeps its signature, delegates rather than duplicating, and every existing injection still works.
41. Manifest `variants` index 0 is the original arm, and `variants.length` equals `generated_variant_count + 1`.
42. The `MatchInput.telemetry` seam: A/A default recall captures with route `lvc_judge_aa`, A/A pinned recall captures nothing, the appropriateness route captures with `unknown_route`, and both right-care scripts write nothing.
43. `index_version` is populated and non-null on every row, **including a row whose retrieval threw on its first statement**, which proves it was stamped before the first fallible call. Both embedding columns, and the `queryEmbedding` short-circuit, produce a value.
44. `active_backfill_state` is `'active'` or `'idle'`, read from `activeRun()`, and an idle tick is not recorded as an interval.
45. Every required field in D17, one absent-or-invalid test each, with own-property checks distinguishing missing, null, empty array, empty string and invalid number.
46. `expansion.served_route_class` null with status `skipped` is valid, so a `normative_channel` row is not partial.
47. The scorer-context HMAC by role: required on `primary`, null on the other four, and those nulls not partial. Computed over the exact `citedContext`, including the empty-string case.
48. An absent HMAC key outside production: no throw, four explicit nulls, `telemetry_error`, a persisting role settling `persisted_partial` and a non-persisting role settling `no_persistence_intended`.
49. All four edge cases in D17, including the two zero-candidate shapes producing different `fused_candidate_count` and `hydrated_candidate_count`.
50. `pre_rerank_passage_hmacs` cardinality equals `hydrated_candidate_ids`, not the fused count.
51. The settlement mapper exhaustively against the full D9 table, then each save expression only for its reachable outcomes and its exact wiring. Exactly-once asserted directly.
52. Every owner in the D9 matrix, including the two scripts, both MCP paths and lab-batch's normal completion.
53. Callback invocation and callback failure, with `saveOpdAudit`'s result preserved.
54. Every allowed and disallowed transition, at fourteen states.
55. Every failure-phase to reconciler-state mapping, the reconciler race against a late terminal write, revision mismatch reread, and no transition of an already terminal row.
56. Recursive canonicalization, nested-key permutation, JSONB round trip, array reorder not equal, undefined array element rejected.
57. `telemetryKeyMissingInProduction` across its five cases, and the source pin that `next.config.mjs`'s inlined condition matches it.
58. The shared duration constant and the worker route literal agree, as a source-text pin.
59. The reconciler cron does not overlap the worker window.
60. **Ranking invariance with identical dependencies on both sides.** Byte-identical ordered output, scorer context, batch boundaries and prompts with instrumentation on and off, with the same injected collaborators running in both cases.
61. **`batchCounters()` by class.** Each of `vertex`, `openrouter`, `local`, `not_served` and `unattributed` increments its own counter and nothing else. A null class increments none of the five. A batch list holding one of each produces five ones and no double count. This test exists because the pre-existing bare `else` merged three facts.
62. **`app_source` binding.** With `APP_SOURCE` set, the insert binds that value. With it absent, the insert binds `'standalone'` and never a null. Assert the bound parameter, not just that the insert succeeded.
63. **`lib/multi-query.ts` still contains the literal `return [];`.** Assert it in this build's own tests as well, so a later refactor sees two failures rather than one puzzling pin in a determinism file.
64. **The two cron-count tests read 17** and no other assertion in either file changed. Assert the second fact with a diff-shape check or a byte comparison of the untouched regions.
65. **The outcome CHECK route step is re-runnable.** Applying the migration route twice leaves the same constraint and does not error, because the `DROP CONSTRAINT IF EXISTS` runs first.
66. **The three table comments differ from each other** and each says what its table actually holds: only `opd_audit_retrieval_telemetry` names `uid`, and the failure table's retention anchor is `observed_at`.
67. **Success attempts reach the manifest.** A path whose provider succeeded records an attempt with outcome `success`, which `classifyAttemptOutcome` never produces, proving the success push sites are instrumented too.
68. **The three outcome-CHECK state sets partition all fourteen states**, with no overlap and none omitted, and `audit_generation_failed` sits in the either set. Assert by set arithmetic against `RETRIEVAL_PERSISTENCE_STATES`, never by a typed count.
69. **The `retrieval_role` CHECK is generated from `RETRIEVAL_ROLES`** and rejects an unknown role. The conditional `NOT NULL` step runs on an empty table and is skipped, with that word in the `steps` response, on a non-empty one.
70. **The Cohere-to-judge downgrade.** Backend Cohere by environment default, `checkHealthy` throws `RerankBackendError`, the judge serves. `intended_backend` is Cohere, `served_backend` is the judge, `rerank_backend_downgraded` is true, `expected_batch_count` matches the judge's batches, and the row is `persisted_complete`. **Also assert that provider selection and fallback order are byte-identical to today**, since PRD section 4.4 forbids changing them.
71. **`telemetryHmac` and `telemetryKeyMissingInProduction` agree on a whitespace-only key.** Both treat it as absent. Neither accepts it.
72. **A legacy `deps.variantsFn` returning `[]` records `not_collected`**, never `parsed_empty` and never `failed_open`, and the row is not partial.
73. **`parse_failure` and `failed_open` are distinguished**, which requires the inner `try` around the parse. A `JSON.parse` throw gives `parse_failure` with the served provider, model and usage preserved. A `governedChat` throw gives `failed_open`.

---

## 7. Gate and report

### Gate, nine commands, all of them

```bash
npm test                       # 1. all green, state the count
npm run typecheck              # 2. clean
npm run build                  # 3. green
npm run architecture:check     # 4.
npm run architecture:map       # 5.
git add lib/architecture/map.generated.ts && npm run architecture:map \
  && git diff --exit-code lib/architecture/map.generated.ts   # 6. determinism
npm run reasoning:registry \
  && git diff --exit-code data/reasoning-registry/prompts.generated.json  # 7.
npm run reasoning:governance   # 8.
npm run changelog:coverage     # 9. read-only regression gate
```

If command 4 fails, read D16's architecture trap before changing anything else. **No engine bump and no scoring changelog edit is authorized.** Command 9 is a read-only regression gate; do not add an entry to satisfy it.

Commit on `exp/rerank-telemetry`. Do not push. Finish with `git status --short` clean and `git show --stat` confirming the build commit contains only the files section 4 authorizes.

### Report

`CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md` in the repository root, committed under the section 0 allowlist.

1. Both commit SHAs, the SHA-256 of the PRD and this kickoff, and **the harness SHA recorded separately from any served deployment SHA.** A clean local tree proves nothing about what Vercel is serving; the served SHA is canary-era and is not yours to record.
2. Results for all nine gate commands, with the test count.
3. **The entry-point and route taxonomy** as mapped in step 1 of the PRD's implementation order.
4. The full DDL as implemented, in both the route and the `.sql`, verbatim, plus the parity pin's output, the stop-rule behaviour, and the three table comments.
5. **The retention, access and deletion statement.** Name the controls that actually apply, which are the admin gates `opd_note_audits` already carries. State that `lib/sql-guard-core.ts` was not edited and why, and that the two committed assertions on its literal are intact. If you think the blocklist is the right long-term home, put it in the defect list, not in the code.
6. Every other inferred SQL string, verbatim: both worker declaration shapes, the transition guard predicate, the reconciler query, each store's statements, and **all ten PRD section 8 query texts**, numbered as the PRD numbers them.
7. **The atomicity declaration.** State plainly that the audit write and the final telemetry link are not transactional, why, and what replaces atomicity. Do not claim atomicity anywhere.
8. The column classification table, and the canonicalization function.
9. **The two counts you verified for yourself**: how many `app/api/admin/migrate-*` directories exist, and how many export a `POST`. State the command you used. If either differs from 38 and 29, say so plainly. This document is not the authority on those numbers.
10. Failure-attribution evidence, and proof the success API and `tracedChat` are unchanged. **Prove all five conditions PRD section 4.4 lists**, one at a time, with the test that proves each: byte-equivalent request parameters, unchanged provider selection and fallback order, unchanged retry behaviour, behaviourally compatible existing callers, and no parent trace id introduced. This build modifies `chatWithFallback`, so none of the five may be asserted without a test behind it.
11. Proof that instrumentation off executes nothing, for all six instrumented functions and for the `MatchInput` seam.
12. The D16 stage mapping as implemented, the three counters' wiring, **the `batchCounters()` branch before and after**, **the Cohere-to-judge downgrade handling with the observed `expected_batch_count` on that path**, and every new module registered for the architecture gate.
13. The D9 owner matrix as wired, one line per path.
14. Instrumented files and a diff summary.
15. Each existing test and source-text pin changed, and the invariant each preserves.
16. Ranking-invariance evidence, with the same dependencies injected on both sides.
17. The cost query text with pricing source, effective or verification date, and unknown-model handling, marked not executed against a live database.
18. **The preregistered grace period value**, recorded now so it cannot be tuned later, with the statement from D13 that one grace for every row is conservative for the short routes and why that is the deliberate choice.
19. **The five PRD section 6.5 overhead numbers from D18**, named as the PRD names them, each with its method, its minimum, median, maximum and sample size, and each labelled synthetic. Then the three extra measurements, separately. Add the note that V judges start-write latency against the throttling behaviour it could perturb, not against a generic budget, and that you propose no thresholds.
20. **A statement that this report asserts none of the six prohibited inferences in PRD section 2**, naming all six.
21. Whether `data/reasoning-registry/prompts.generated.json` changed, and if so what changed in it and why a telemetry build moved the reasoning registry at all.
22. Anything flagged rather than decided.
23. Defects found and left alone, including `bedrockOnlyChat` and `tracedChat` attaching no attempts, and anything you were told to put in this list rather than fix: the `lib/sql-guard-core.ts` question from D3, and `tracedChat`'s attribution from D14.

Do not recommend a canary date. Do not start C0. Do not prepare C0.5, C0.6, C1, C2, Q1 or F1.

---

## 8. Flag, do not improvise

If the PRD and this kickoff together do not settle something, put it in the report and leave the code alone. A defect found on the way goes in the list and stays there. The engine is frozen, this build sits inside the remediation lift and does not consume it, and V signs each exception in writing.

---

## 9. What V does

**Before any deploy:** add `CDMSS_TELEMETRY_HMAC_KEY` to Vercel Production.

**To apply the migration:** run `POST /api/admin/migrate-retrieval-telemetry` once from the admin dashboard, the way every other migration in this repository is applied. Read its `steps` response. If it reports the table exists with rows, stop and decide the legacy-data policy first.

**After the build report:** set numeric values for the five overhead guardrails, judging start-write latency against the throttling behaviour rather than a generic budget. Then decide the canary and authorise the deploy.
