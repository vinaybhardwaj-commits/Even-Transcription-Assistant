-- 0056_triage_shadow_proposals.sql — CAT Managed Care Audit Triage shadow store
-- (CDMSS-PROPOSAL-TRIAGE-SHADOW-BOT, T-D1 / T-D8, 16 Sep 2026).
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/triage/shadow-propose, which runs this DDL idempotently
-- (CREATE TABLE IF NOT EXISTS + unique index) before the first append.
--
-- MIGRATION NUMBER 0056. 0055 is the highest committed number; 0056 is the next free one.
--
-- ⚠️ CREATE ONLY. This file ALTERs no existing table and DROPs nothing. In particular it does not
-- touch opd_audit_triage, opd_gov_signal, opd_gov_signal_event, opd_note_audits, cognition_*,
-- stewardship, Review Mode, even-elo, Pulse, or any WM table. NO ENGINE BUMP anywhere.
--
-- ⚠️ SHADOW ONLY. A row here is a bot PROPOSAL. It is not a CM stamp. Nothing here mints
-- opd_gov_signal or changes /care/triage UI behaviour.
--
-- Idempotence: UNIQUE (queue_item_ref, run_id) — one proposal per Action-queue card per bot run.
-- queue_item_ref is doctor_uid|signal_type, the same card identity the CM Action queue uses.
--
-- proposed_verb ∈ {valid, bug, route, hold, drop_informational} — enforced in lib/triage/shadow-schema.ts.

CREATE TABLE IF NOT EXISTS triage_shadow_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  app_source      text NOT NULL DEFAULT 'standalone',
  queue_item_ref  text NOT NULL,
  proposed_verb   text NOT NULL,
  reason          text,
  confidence      double precision,
  policy_version  text NOT NULL,
  run_id          text NOT NULL,
  actor           text
);

CREATE UNIQUE INDEX IF NOT EXISTS triage_shadow_proposals_identity_uq
  ON triage_shadow_proposals (queue_item_ref, run_id);
