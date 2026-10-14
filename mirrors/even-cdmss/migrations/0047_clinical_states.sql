-- 0047_clinical_states.sql — the per-stay ClinicalState document library
-- (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P2 / O9).
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-clinical-states, which runs this DDL idempotently.
--
-- NO ENGINE BUMP, NO SCHEMA BUMP. IPD stays 'ipd-discharge-audit/0.2' and ClinicalState
-- stays 'clinical-state/1.2' (§7). Nothing detected, audited or scored changes: this
-- migration adds storage for documents that already exist on db13, in a shape that already
-- exists in the codebase.
--
-- clinical_states — ONE ROW PER STAY DOCUMENT, keyed (doc_kind, source_uid, schema_version).
--   doc_kind       'discharge' | 'ot' | 'pac' | 'progress'. O10 — those four and no more this
--                  ship. CM / POST_IPD notes are OUT; MAR / nursing / handover are out of the
--                  promote path entirely.
--   source_uid     the DOCUMENT's own id: a kx_clinical_template_* row `uid`, or the discharge
--                  document id. For a class that produced NOTHING it is the sentinel
--                  'absent:<kind>:<encounter>' — see the absence note below.
--   member_uid     the FIRESTORE member id from ipd_discharge_audits.member_id. It is NOT an
--                  individual_uid and nothing here may treat it as one: the identity hop is
--                  P4's, at fold time (O12). This column exists so P4 has somewhere to hop
--                  FROM. No Even account number ever lands on Neon.
--   encounter_ref  the IP encounter this document belongs to — how a STAY is read back.
--   schema_version 'clinical-state/1.2', so a future schema bump opens new rows instead of
--                  rewriting states that were built under the old shape.
--   status         'ok' | 'not_auditable'. Two values, per O9.
--   state_json     the ClinicalState. The not_auditable REASON lives in here
--                  (surfaceExtras.stayDoc.reason), not in the status column, because the
--                  difference between 'the row is not filed' and 'the look faulted' is
--                  load-bearing and O9 fixes status to two values.
--
-- WHY AN ABSENCE GETS A ROW. A stay with no OT note is a stay whose theatre record we have not
-- seen — NOT a stay with no operation (D13). If absence were simply a missing row, a reader
-- could not tell a stay nobody built from a stay whose OT note does not exist, and the second
-- reading is the one that invents a clean theatre. So every document class writes a row, and
-- the sentinel source_uid is derived from the stay so a rebuild replaces it in place.
--
-- NOTHING ELSE IS TOUCHED. This migration creates one table. It ALTERs nothing, so no audit,
-- feedback, episode or member-state row can be affected by running it, and running it twice is
-- the same as running it once.

CREATE TABLE IF NOT EXISTS clinical_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  doc_kind        TEXT NOT NULL,
  source_uid      TEXT NOT NULL,
  member_uid      TEXT,
  encounter_ref   TEXT,
  schema_version  TEXT NOT NULL,
  status          TEXT NOT NULL,
  state_json      JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS clinical_states_doc_idx
  ON clinical_states (doc_kind, source_uid, schema_version);
-- The stay read: every document for one encounter at one schema version.
CREATE INDEX IF NOT EXISTS clinical_states_encounter_idx
  ON clinical_states (encounter_ref, schema_version);
-- P4 starts its identity hop from member_uid; this keeps that lookup cheap without making
-- member_uid unique (one member has many stays, and a household must never collapse).
CREATE INDEX IF NOT EXISTS clinical_states_member_idx
  ON clinical_states (member_uid, schema_version);
