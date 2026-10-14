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
  PRIMARY KEY (rule_ref, version)
);

CREATE INDEX IF NOT EXISTS lvc_rule_versions_ref_idx ON lvc_rule_versions (rule_ref, version DESC);

CREATE TABLE IF NOT EXISTS lvc_rule_activation_events (
  id              bigserial PRIMARY KEY,
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
  created_at      timestamptz NOT NULL DEFAULT now()
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
  created_at        timestamptz NOT NULL DEFAULT now()
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
