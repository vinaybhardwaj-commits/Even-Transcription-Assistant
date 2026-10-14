-- 0035_opd_audit_retrieval_telemetry.sql
-- CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026 §4.2, and the on-path kickoff's D1/D2/D3.
--
-- ⚠️ THIS FILE IS DOCUMENTATION. IT IS NOT APPLIED BY ANYTHING.
-- There is no migration runner in this repository — nothing reads migrations/*.sql. Schema changes
-- are applied by idempotent admin routes, and this one's route is:
--
--     app/api/admin/migrate-retrieval-telemetry/route.ts   ← THE THING THAT ACTUALLY RUNS
--
-- The route builds every CHECK value list from the exported constants in
-- lib/retrieval-telemetry-core.ts (D2 forbids hand-typing them). THIS FILE IS HAND-TYPED, and
-- lib/__tests__/migrate-retrieval-telemetry-parity.test.ts holds the two together statement for
-- statement and CHECK value for CHECK value, in both directions. If you change one, the test
-- fails until you change the other. Do not generate this file from the constants: a generated
-- mirror would make that test tautological, and the test is the only thing keeping the
-- documentation honest.
--
-- ⚠️ THE ROUTE HAS A STOP RULE THIS FILE CANNOT EXPRESS. If opd_audit_retrieval_telemetry already
-- exists WITH ROWS, the route changes nothing, returns 409 with the row count and a state
-- histogram, and waits for a signed legacy-data policy. The persistence-state vocabulary below
-- goes from the eight values the original 0035 declared to fourteen, and drops `not_eligible`;
-- replacing a constraint under existing rows is a decision, not a schema step.
--
-- ── WHY A DEDICATED TABLE AND NOT trace_events ─────────────────────────────────────────────────
-- The rerank judge is TRACELESS by requirement (PRD §3 constraint 2: passing a parent trace id
-- into governedChat changes transport behaviour). It therefore writes no trace and no trace_event,
-- which is exactly why the 11 Aug throttle-rate census could count 21 local substitutions and not
-- say which caller owned them, and why the cost tracker — which joins trace_events to traces —
-- shows zero rupees for every rerank call ever made.
--
-- ── RETENTION, ACCESS AND DELETION (§4.2, required) ────────────────────────────────────────────
-- Declared per table in the three COMMENT ON TABLE statements at the foot of this file, with the
-- correct anchor column named in each — started_at on the first two, observed_at on the failure
-- table, which has no started_at. In summary:
--   · ACCESS.    The admin gate on the route, which is the control opd_note_audits itself carries.
--                That is the standard §4.2 sets: controls NO WEAKER than opd_note_audits.
--                ⚠️ lib/sql-guard-core.ts is NOT edited. Its blocked-relation list exists for
--                tables carrying raw clinician-typed text; these carry none by construction, and
--                opd_note_audits is not on that list either — so blocking here would be STRONGER
--                than required, at the cost of a guard two committed tests assert byte-identical.
--   · RETENTION. 90 days. A run older than a quarter answers no live question.
--   · DELETION.  Operator-scheduled purge, NOT automated here and NOT a trigger. Automating a
--                delete against a table that may hold the only evidence of an unreconciled
--                incident is a decision, not a default. The started_at / observed_at indexes make
--                the delete cheap when the owner schedules it.
--                A patient erasure that removes an opd_note_audits row must remove the rows here
--                carrying the same uid. The FK is ON DELETE SET NULL so a deleted audit does not
--                silently drop its telemetry — which would destroy the reconciliation record —
--                and `uid` is what the erasure must target, deliberately and by name.
--   · NO CLINICAL TEXT. Identifiers, enums, counts, timings and keyed HMACs only. No question,
--                passage, instruction or rendered scorer context is ever stored here. Only the
--                first table carries a patient identifier at all.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE RETRIEVAL-EXECUTION TABLE
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- One row per retrieval EXECUTION (§4.1). retrieval_run_id is NOT an audit id and is never derived
-- from (uid, engine_version) — two concurrent executions for the same note must stay two rows.
--
-- audit_id is linked only AFTER the audit persistence result is known (§4.5 step 4). NULL is a
-- real, expected state: a losing ON CONFLICT race, a failed save, or a retrieval that never
-- produced an audit row. §4.2 forbids creating synthetic audit rows to populate it.
--
-- ⚠️ NO INLINE persistence_state CHECK, deliberately. The original 0035 declared one here with the
-- eight old values. Keeping that shape would put the state vocabulary in two places in one
-- migration — here and in the named constraint D2 requires be DROPped and re-ADDed — and a reader
-- would have to check the two agree. There is one home for it: section 3 below.
CREATE TABLE IF NOT EXISTS opd_audit_retrieval_telemetry (
  retrieval_run_id UUID PRIMARY KEY,
  audit_id UUID NULL REFERENCES opd_note_audits(id) ON DELETE SET NULL,
  trace_id TEXT NULL,
  uid TEXT NULL,
  engine_version TEXT NULL,
  route TEXT NOT NULL,
  invocation_id TEXT NULL,
  app_source TEXT NOT NULL DEFAULT 'standalone',
  deployment_sha TEXT NULL,
  telemetry_schema_version INTEGER NOT NULL,
  experiment_run_id TEXT NULL,
  pair_id TEXT NULL,
  replicate TEXT NULL,
  persistence_state TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  expansion_status TEXT NULL,
  expansion_route_class TEXT NULL,
  rerank_route_class TEXT NULL,
  expected_rerank_batches INTEGER NULL,
  recorded_rerank_batches INTEGER NULL,
  rerank_vertex_batches INTEGER NOT NULL DEFAULT 0,
  rerank_openrouter_batches INTEGER NOT NULL DEFAULT 0,
  rerank_local_batches INTEGER NOT NULL DEFAULT 0,
  rerank_failed_batches INTEGER NOT NULL DEFAULT 0,
  rerank_unattributed_batches INTEGER NOT NULL DEFAULT 0,
  rerank_429_attempts INTEGER NOT NULL DEFAULT 0,
  context_hmac TEXT NULL,
  retrieval_manifest JSONB NULL,
  telemetry_error TEXT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. THE ON-PATH ADDITIONS (D2)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- fused_candidate_count and hydrated_candidate_count are TWO COUNTS, NOT ONE: the pool after the
-- cap, and the rows the re-read actually returned. Their difference is a dropped row, which is
-- invisible if only one is recorded.
--
-- index_version is the embedding column plus the embed model that column implies — together, which
-- candidates exist at all. Stamped before the first fallible statement in retrieve(), so a row
-- that fails still records the index it was reading.
--
-- active_backfill_state is 'active' or 'idle'. LOAD-BEARING: without it a cron tick cannot be
-- distinguished from real work, which §2 forbids twice.
ALTER TABLE opd_audit_retrieval_telemetry
  ADD COLUMN IF NOT EXISTS retrieval_role TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_outcome TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_error_class TEXT,
  ADD COLUMN IF NOT EXISTS persistence_settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expansion_served_model TEXT,
  ADD COLUMN IF NOT EXISTS expansion_attempts JSONB,
  ADD COLUMN IF NOT EXISTS rerank_not_served_batches INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rerank_soft_failed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS served_backend TEXT,
  ADD COLUMN IF NOT EXISTS rerank_backend_downgraded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fused_candidate_count INTEGER,
  ADD COLUMN IF NOT EXISTS hydrated_candidate_count INTEGER,
  ADD COLUMN IF NOT EXISTS index_version TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_run_id TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_target TEXT,
  ADD COLUMN IF NOT EXISTS active_backfill_state TEXT,
  ALTER COLUMN app_source SET DEFAULT 'standalone';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. THE THREE CHECKS, IN ONE STATEMENT
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Every value list below is GENERATED in the route from the exported constants in
-- lib/retrieval-telemetry-core.ts. The copies here are hand-typed and are held to the route's
-- output by the parity test. RETRIEVAL_PERSISTENCE_STATES is the source of truth for the first,
-- RETRIEVAL_ROLES for the second, OUTCOME_REQUIRED_STATES and OUTCOME_EITHER_STATES for the third.
--
-- ⚠️ ONE ALTER TABLE, NOT SIX STATEMENTS. The CREATE TABLE above carries no inline CHECK, so this
-- is the ONLY source of all three constraints — and the route runs its statements in a plain loop
-- with no transaction, so a failure between a separate DROP and its separate ADD left this table
-- UNCONSTRAINED with nothing later restoring it. Collapsed, the replacement is atomic: one lock,
-- one validation pass over existing rows.
--
-- ⚠️ DROPPING AND ADDING THE SAME NAME IN ONE STATEMENT IS LEGAL, and it works because PostgreSQL
-- sorts an ALTER TABLE's subcommands into ordered passes in which drops precede adds — NOT because
-- the actions run left to right. Do not reason about this statement by reading it top to bottom.
-- One bad row now fails the whole replacement rather than leaving the table half constrained.
--
-- Idempotent in both directions: DROP … IF EXISTS tolerates absence on a fresh table, and each ADD
-- names a constraint this same statement has already freed.
--
-- The role CHECK is unconditional: a NULL role passes a CHECK by SQL's own rules, which is why the
-- NOT NULL has to be a separate, conditional step — see the note at the foot of this section.
--
-- retrieval_outcome stays NULLABLE because the worker inserts `started` rows before retrieval
-- starts. The STATE is what makes an outcome required, so that guard is stateful. The three sets
-- partition all fourteen states: 'started' alone, the nine that require an outcome, and the four
-- that permit either. audit_generation_failed is in the EITHER set, not the required one — a row
-- settled from `started` never recorded an outcome, and D12 permits that transition.
ALTER TABLE opd_audit_retrieval_telemetry
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_persistence_state_chk,
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_role_chk,
  DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_outcome_chk,
  ADD CONSTRAINT opd_audit_retrieval_telemetry_persistence_state_chk CHECK (persistence_state IN ('started', 'retrieval_complete', 'persisted_complete', 'persisted_partial', 'completed_unpersisted', 'persistence_refused', 'audit_persistence_failed', 'audit_generation_failed', 'telemetry_persistence_failed', 'aborted', 'persistence_unknown', 'retrieval_not_run', 'no_persistence_intended', 'persistence_skipped')),
  ADD CONSTRAINT opd_audit_retrieval_telemetry_role_chk CHECK (retrieval_role IN ('primary', 'normative_channel', 'lvc_recall', 'lab_direct', 'lab_multi_query')),
  ADD CONSTRAINT opd_audit_retrieval_telemetry_outcome_chk CHECK (
  (persistence_state = 'started' AND retrieval_outcome IS NULL)
  OR (persistence_state IN ('retrieval_complete', 'persisted_complete', 'persisted_partial', 'completed_unpersisted', 'persistence_refused', 'audit_persistence_failed', 'persistence_skipped', 'no_persistence_intended', 'persistence_unknown') AND retrieval_outcome IS NOT NULL)
  OR persistence_state IN ('aborted', 'retrieval_not_run', 'telemetry_persistence_failed', 'audit_generation_failed')
);

-- ⚠️ THE ONE STATEMENT THIS FILE DELIBERATELY DOES NOT CARRY, and the only permitted difference
-- between this mirror and the route (it is named as such in the parity test's allowed-difference
-- list, and nowhere else):
--
--     ALTER TABLE opd_audit_retrieval_telemetry ALTER COLUMN retrieval_role SET NOT NULL
--
-- The route applies it ONLY when the table is empty, and reports 'skipped, table not empty'
-- otherwise. An existing row's role cannot be reconstructed, and a failed SET NOT NULL would abort
-- the migration over history rather than over anything this build wrote. A .sql file cannot
-- branch, so the rule is stated here instead of being half-applied.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. INDEXES ON THE RETRIEVAL TABLE
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Nightly window scans and the stale-start reconciler both range over started_at.
CREATE INDEX IF NOT EXISTS opd_art_started_at_idx ON opd_audit_retrieval_telemetry (started_at DESC);

CREATE INDEX IF NOT EXISTS opd_art_state_started_at_idx ON opd_audit_retrieval_telemetry (persistence_state, started_at DESC);

-- Audit linkage, and the "which audits have no telemetry" half of the canary gate.
CREATE INDEX IF NOT EXISTS opd_art_audit_id_idx ON opd_audit_retrieval_telemetry (audit_id) WHERE audit_id IS NOT NULL;

-- Concurrency: two executions for the same note must be visible AS two.
CREATE INDEX IF NOT EXISTS opd_art_uid_engine_idx ON opd_audit_retrieval_telemetry (uid, engine_version, started_at DESC);

-- Route/invocation overlap analysis (§8: worker vs ACTIVE backfill vs hosted lab).
CREATE INDEX IF NOT EXISTS opd_art_route_invocation_idx ON opd_audit_retrieval_telemetry (route, invocation_id, started_at DESC);

-- Experiment linkage for A/A replicates.
CREATE INDEX IF NOT EXISTS opd_art_experiment_idx ON opd_audit_retrieval_telemetry (experiment_run_id, pair_id) WHERE experiment_run_id IS NOT NULL;

-- §7's per-role coverage question: one primary row per audit, one normative_channel row when that
-- channel was declared, none when it was not.
CREATE INDEX IF NOT EXISTS opd_art_role_state_idx ON opd_audit_retrieval_telemetry (retrieval_role, persistence_state, started_at DESC);

-- The reconciler's hot path: the two non-terminal states, oldest first.
CREATE INDEX IF NOT EXISTS opd_art_nonterminal_idx ON opd_audit_retrieval_telemetry (persistence_state, started_at) WHERE persistence_state IN ('started', 'retrieval_complete');

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. INVOCATION ACCOUNTING
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- One row per serverless invocation that declared retrieval work, plus reconciler runs.
-- telemetry_write_failures is incremented ONLY by the failure store's own fail-open handler: when
-- even the failure row cannot be written, this counter is the last surviving evidence. §4.1 forbids
-- process-global mutable state, and a per-process number would not survive the invocation anyway.
CREATE TABLE IF NOT EXISTS opd_retrieval_invocations (
  invocation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  route_class TEXT NOT NULL,
  app_source TEXT NOT NULL DEFAULT 'standalone',
  deployment_sha TEXT NULL,
  vercel_request_id TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL,
  closure_state TEXT NOT NULL DEFAULT 'closure_unknown',
  declared_retrievals INTEGER NOT NULL DEFAULT 0,
  telemetry_write_failures INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT opd_ri_kind_chk CHECK (kind IN ('retrieval', 'reconciler')),
  CONSTRAINT opd_ri_closure_chk CHECK (closure_state IN ('closed', 'closure_unknown'))
);

CREATE INDEX IF NOT EXISTS opd_ri_open_idx ON opd_retrieval_invocations (started_at) WHERE closure_state = 'closure_unknown';

CREATE INDEX IF NOT EXISTS opd_ri_route_time_idx ON opd_retrieval_invocations (route, started_at DESC);

CREATE INDEX IF NOT EXISTS opd_ri_kind_time_idx ON opd_retrieval_invocations (kind, started_at DESC);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. PER-RUN TELEMETRY-WRITE FAILURE EVIDENCE
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- error_class is a CLASS NAME. Never a message, never a value. Failure rows are historical: the
-- reconciler reads them and never deletes or consumes them, and a successful terminal state always
-- wins over earlier failure evidence.
CREATE TABLE IF NOT EXISTS opd_retrieval_telemetry_failures (
  id BIGSERIAL PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  retrieval_run_id UUID NULL,
  retrieval_role TEXT NULL,
  failed_phase TEXT NOT NULL,
  intended_state TEXT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  error_class TEXT NOT NULL,
  CONSTRAINT opd_rtf_phase_chk CHECK (failed_phase IN ('invocation_start', 'work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected', 'persistence_link', 'closure')),
  CONSTRAINT opd_rtf_run_chk CHECK (
    (failed_phase IN ('work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected', 'persistence_link') AND retrieval_run_id IS NOT NULL AND retrieval_role IS NOT NULL)
    OR failed_phase IN ('invocation_start', 'closure')
  )
);

-- ⚠️ THE FAILURE-TABLE CHECKS, RE-APPLIED (pass 0a). The inline constraints above reach a FRESH
-- table only: CREATE TABLE IF NOT EXISTS is a no-op when the table exists, so on a database that
-- already has this table the OLD CHECKs survive and `retrieval_terminal_rejected` would be rejected
-- by the constraint. Drop-then-add is the same idiom the collapsed opd_audit_retrieval_telemetry
-- statement above uses, and it is idempotent in both directions.
--
-- ⚠️ ONE ALTER TABLE, NOT FOUR STATEMENTS. Unlike the retrieval table, this one does carry both
-- CHECKs inline in its CREATE TABLE, so a half-applied pair could not leave a FRESH table
-- unconstrained. It is collapsed for the same reason regardless: one lock, one validation pass, and
-- no window in which an EXISTING table has lost a constraint that nothing later restores. Drops
-- still run before adds — by ALTER TABLE's pass ordering, not by their position in the list.
ALTER TABLE opd_retrieval_telemetry_failures
  DROP CONSTRAINT IF EXISTS opd_rtf_phase_chk,
  DROP CONSTRAINT IF EXISTS opd_rtf_run_chk,
  ADD CONSTRAINT opd_rtf_phase_chk CHECK (failed_phase IN ('invocation_start', 'work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected', 'persistence_link', 'closure')),
  ADD CONSTRAINT opd_rtf_run_chk CHECK (
    (failed_phase IN ('work_declaration', 'retrieval_terminal', 'retrieval_terminal_rejected', 'persistence_link') AND retrieval_run_id IS NOT NULL AND retrieval_role IS NOT NULL)
    OR failed_phase IN ('invocation_start', 'closure')
  );

CREATE INDEX IF NOT EXISTS opd_rtf_run_idx ON opd_retrieval_telemetry_failures (retrieval_run_id, failed_phase, observed_at DESC) WHERE retrieval_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS opd_rtf_invocation_idx ON opd_retrieval_telemetry_failures (invocation_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS opd_rtf_phase_time_idx ON opd_retrieval_telemetry_failures (failed_phase, observed_at DESC);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. TABLE COMMENTS — the text DIFFERS PER TABLE, because the tables differ
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Only the first names uid. Only the third anchors its retention on observed_at.
COMMENT ON TABLE opd_audit_retrieval_telemetry IS 'Stage 0a rerank telemetry, one row per retrieval execution. Observation only: no ranking decision reads this table. uid is a re-identification key and carries controls no weaker than opd_note_audits (admin-gated reads only). No clinical text: identifiers, enums, counts, timings and keyed HMACs only. Retention 90 days from started_at; the purge is operator-scheduled and is NOT implemented here.';

COMMENT ON TABLE opd_retrieval_invocations IS 'Stage 0a invocation accounting, one row per serverless invocation that declared retrieval work, plus reconciler runs. Observation only. No clinical text and NO PATIENT IDENTIFIER — it joins to the uid-bearing table and inherits its handling. Admin access only. Retention 90 days from started_at; the purge is operator-scheduled and is NOT implemented here.';

COMMENT ON TABLE opd_retrieval_telemetry_failures IS 'Stage 0a telemetry-write failure evidence, one row per failed write. Observation only. No clinical text and NO PATIENT IDENTIFIER. error_class is a class name and is never a message or a value. Admin access only. Retention 90 days from observed_at — this table has no started_at — and the purge is operator-scheduled and is NOT implemented here.';
