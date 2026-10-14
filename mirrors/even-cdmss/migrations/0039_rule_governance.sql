-- 0039_rule_governance.sql — R3-A: the dormant rule-governance foundation.
-- CDMSS R3-A PRD + Coder Kickoff, 20 Aug 2026. Migration ordinal 0039, assigned by Saul Rep 41
-- (telemetry holds 0037, facts-then-rules PR 2 holds 0038, LVP L2 moves to 0040 — do not renumber).
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is GET /api/admin/migrate-rule-governance,
-- which runs this DDL idempotently from the string constants in lib/rule-governance-store.ts
-- (migrations/ is not bundled into the Vercel serverless function; only imported code ships).
-- lib/__tests__/rule-governance-migration.test.ts asserts this file and those constants agree
-- statement-for-statement, so the pair cannot fork silently.
--
-- IT DOES NOT RUN ITSELF. No cron, no build hook, no deploy step. The route is behind
-- LVC_RULE_GOVERNANCE_ENABLED === '1' — which ships UNSET — and then behind the admin gate.
--
-- ADDITIVE AND SINGLE-TARGET. Four new objects and nothing else: no existing table is changed, no
-- existing row is rewritten, nothing is removed. `lvc_recommendations` is not a target of any
-- statement in this file. Six of its eleven readers do not filter `status`, so one new row or one
-- new status value would silently change the audit note page, both provenance-tier reads, the MCP
-- dedup gate, lvc_gaps and the wording readback. Governance state lives ENTIRELY in these tables —
-- the boundary migration 0023 already drew for proposals.
--
-- THE SHAPE (S2, Saul Rep 41): lvc_rule_versions is IMMUTABLE and has NO valid_to column.
-- Activation and retirement are append-only events. [valid_from, valid_to) is DERIVED by
-- v_lvc_rule_validity from the event stream. Reactivating an earlier version appends a second
-- activate event and therefore yields a second window.
--
-- EVIDENCE (§3.4): every governance row carries the mandatory tuple copied from
-- lvc_concept_rulings (0020:28-43) — ratified_by (a named human, never 'admin'), rationale,
-- sample_size, reviewed_n, sample_seed, plus n_not_belonging where meaningful. Its rationale,
-- verbatim: "they exist so a later reader can distinguish a ruling made on evidence from one made
-- on a label. reviewed_n = 0 is a ruling on an abstraction."
--
-- No PHI on any of these rows: rule text, pattern identities and de-identified shelf example lines.

CREATE TABLE IF NOT EXISTS lvc_rule_versions (
  rule_ref              text NOT NULL,
  version               int  NOT NULL,
  statement             text NOT NULL,
  precondition          text,
  action_type           text,
  keywords              jsonb,
  category              text,
  definition_hash       text NOT NULL,
  origin                text NOT NULL CHECK (origin IN ('bootstrap_snapshot','proposal')),
  evaluator_disposition text NOT NULL DEFAULT 'informational' CHECK (evaluator_disposition = 'informational'),
  proposal_id           uuid,
  ratified_by           text NOT NULL,
  rationale             text NOT NULL,
  sample_size           int  NOT NULL,
  reviewed_n            int  NOT NULL,
  sample_seed           text NOT NULL,
  n_not_belonging       int,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_ref, version),
  CONSTRAINT lvc_rule_versions_version_positive CHECK (version > 0),
  CONSTRAINT lvc_rule_versions_ref_nonblank     CHECK (btrim(rule_ref) <> ''),
  CONSTRAINT lvc_rule_versions_statement_nonblank CHECK (btrim(statement) <> ''),
  CONSTRAINT lvc_rule_versions_ratifier_named CHECK (
    btrim(ratified_by) <> ''
    AND lower(btrim(ratified_by)) NOT IN ('admin','system','cron','worker','care-manager')),
  CONSTRAINT lvc_rule_versions_rationale_nonblank CHECK (btrim(rationale) <> ''),
  CONSTRAINT lvc_rule_versions_seed_nonblank      CHECK (btrim(sample_seed) <> ''),
  CONSTRAINT lvc_rule_versions_counts_nonneg      CHECK (sample_size >= 0 AND reviewed_n >= 0),
  CONSTRAINT lvc_rule_versions_reviewed_le_sample CHECK (reviewed_n <= sample_size),
  CONSTRAINT lvc_rule_versions_nnb_bounds         CHECK (n_not_belonging IS NULL
                                           OR (n_not_belonging >= 0 AND n_not_belonging <= reviewed_n))
);

CREATE INDEX IF NOT EXISTS lvc_rule_versions_ref_idx ON lvc_rule_versions (rule_ref, version DESC);

CREATE TABLE IF NOT EXISTS lvc_rule_activation_events (
  id              bigserial PRIMARY KEY,
  event_ref       uuid NOT NULL UNIQUE,
  rule_ref        text NOT NULL,
  version         int  NOT NULL,
  event           text NOT NULL CHECK (event IN ('activate','retire')),
  effective_at    timestamptz NOT NULL DEFAULT now(),
  ratified_by     text NOT NULL,
  rationale       text NOT NULL,
  sample_size     int  NOT NULL,
  reviewed_n      int  NOT NULL,
  sample_seed     text NOT NULL,
  n_not_belonging int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lvc_rule_activation_events_version_positive CHECK (version > 0),
  CONSTRAINT lvc_rule_activation_events_version_fk
    FOREIGN KEY (rule_ref, version) REFERENCES lvc_rule_versions (rule_ref, version),
  CONSTRAINT lvc_rule_activation_events_ratifier_named CHECK (
    btrim(ratified_by) <> ''
    AND lower(btrim(ratified_by)) NOT IN ('admin','system','cron','worker','care-manager')),
  CONSTRAINT lvc_rule_activation_events_rationale_nonblank CHECK (btrim(rationale) <> ''),
  CONSTRAINT lvc_rule_activation_events_seed_nonblank      CHECK (btrim(sample_seed) <> ''),
  CONSTRAINT lvc_rule_activation_events_counts_nonneg      CHECK (sample_size >= 0 AND reviewed_n >= 0),
  CONSTRAINT lvc_rule_activation_events_reviewed_le_sample CHECK (reviewed_n <= sample_size),
  CONSTRAINT lvc_rule_activation_events_nnb_bounds         CHECK (n_not_belonging IS NULL
                                           OR (n_not_belonging >= 0 AND n_not_belonging <= reviewed_n))
);

CREATE INDEX IF NOT EXISTS lvc_rule_activation_events_stream_idx ON lvc_rule_activation_events (rule_ref, effective_at, id);

CREATE TABLE IF NOT EXISTS rule_pattern_map (
  id                bigserial PRIMARY KEY,
  lvp_pattern_id    text NOT NULL,
  rule_ref          text NOT NULL,
  evidence_snapshot jsonb NOT NULL,
  ratified_by       text NOT NULL,
  rationale         text NOT NULL,
  sample_size       int  NOT NULL,
  reviewed_n        int  NOT NULL,
  sample_seed       text NOT NULL,
  n_not_belonging   int,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_pattern_map_pattern_nonblank CHECK (btrim(lvp_pattern_id) <> ''),
  CONSTRAINT rule_pattern_map_ref_nonblank     CHECK (btrim(rule_ref) <> ''),
  CONSTRAINT rule_pattern_map_ratifier_named CHECK (
    btrim(ratified_by) <> ''
    AND lower(btrim(ratified_by)) NOT IN ('admin','system','cron','worker','care-manager')),
  CONSTRAINT rule_pattern_map_rationale_nonblank CHECK (btrim(rationale) <> ''),
  CONSTRAINT rule_pattern_map_seed_nonblank      CHECK (btrim(sample_seed) <> ''),
  CONSTRAINT rule_pattern_map_counts_nonneg      CHECK (sample_size >= 0 AND reviewed_n >= 0),
  CONSTRAINT rule_pattern_map_reviewed_le_sample CHECK (reviewed_n <= sample_size),
  CONSTRAINT rule_pattern_map_nnb_bounds         CHECK (n_not_belonging IS NULL
                                           OR (n_not_belonging >= 0 AND n_not_belonging <= reviewed_n))
);

CREATE INDEX IF NOT EXISTS rule_pattern_map_pattern_idx ON rule_pattern_map (lvp_pattern_id, created_at DESC);

CREATE OR REPLACE VIEW v_lvc_rule_validity AS
SELECT w.rule_ref, w.version, w.valid_from, w.valid_to
  FROM (
    SELECT e.rule_ref, e.version, e.event,
           e.effective_at AS valid_from,
           lead(e.effective_at) OVER (PARTITION BY e.rule_ref ORDER BY e.effective_at, e.id) AS valid_to
      FROM lvc_rule_activation_events e
  ) w
 WHERE w.event = 'activate';
