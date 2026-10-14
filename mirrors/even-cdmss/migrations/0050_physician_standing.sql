-- 0050_physician_standing.sql — the medical superintendent's stated standing on a clinician or a
-- department (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, S4; spec §6.3 / §12.3).
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-physician-standing, which runs this DDL idempotently.
--
-- MIGRATION NUMBER 0050. The spec said 0046; 0046-0049 were taken by the time this shipped, and
-- 0050 is the next free number (kickoff §1).
--
-- NO ENGINE BUMP anywhere. OPD stays 'opd-note-audit/0.81.21', IPD stays
-- 'ipd-discharge-audit/0.2', readmissions stays 'readmission/0.2'. Nothing detected, audited or
-- scored changes. This migration adds storage for a HUMAN JUDGEMENT, and for nothing else.
--
-- ⚠️ CREATE ONLY. This file ALTERs no existing table and DROPs nothing. In particular it does not
-- touch opd_note_audits, ipd_discharge_audits, opd_audit_feedback, ipd_audit_feedback or
-- case_ask_turns, so it cannot move a score, a band, a verdict or a stored conversation.
--
-- physician_standing — one row per STATEMENT, append-only.
--   case_type       'physician' | 'dept' — the same two case types the stewardship Ask serves.
--   case_key        the doctor_uid, or '<vocab>:<label>' for a department (A3).
--   engine_version  the thread's engine string, 'opd-0.81.x+ipd-0.2|90d' (A3). STORED so a reader
--                   can ask which numbers a standing was said about; deliberately NOT part of the
--                   current-standing read, because A3's key is a family string and a patch bump
--                   must not silently drop every judgement on the board.
--   standing        'standing' | 'concern' | 'restricted-review' | 'insufficient'. Closed set,
--                   enforced in code by the §12.3 gate before the row is built.
--   quote           the auditor's OWN words, capped. The gate rejects anything that is not a
--                   substring of his turn — a paraphrase is not a statement.
--   actor           the ROLE the request proved — 'admin'. O8: there is no per-person reviewer
--                   identity in this app and this ship does not invent one.
--   turn_id         the case_ask_turns row this statement was made in, so a standing can always be
--                   read back in the conversation that produced it.
--   model           the pinned Opus id that served the call the overlay was reported on.
--   window_days     90 — the board window the judgement was made against.
--   authority       'medical_superintendent' (§6.3), stored so the table alone says who may write.
--   stated          always TRUE. §6.3: inferred never writes. Kept as a column so the row carries
--                   its own gate rather than relying on the code that inserted it.
--
-- APPEND-ONLY BY DESIGN: there is no UPDATE path and no unique index that would force one. A
-- superintendent changing his mind is a SECOND ROW. A standing is a statement a named person made
-- on a date, and rewriting one would destroy the only thing it is evidence of.
--
-- DELIBERATELY ABSENT: any column that could be joined into a score. No NQI, no CVI, no band, no
-- avoidable, no finding reference. §6.3 forbids an aggregator reading this blob at all, and the
-- cheapest way to keep that true is to store nothing an aggregator would want.

CREATE TABLE IF NOT EXISTS physician_standing (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  case_type       TEXT NOT NULL,
  case_key        TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  standing        TEXT NOT NULL,
  quote           TEXT NOT NULL,
  actor           TEXT,
  turn_id         TEXT,
  model           TEXT,
  window_days     INT,
  authority       TEXT NOT NULL DEFAULT 'medical_superintendent',
  stated          BOOLEAN NOT NULL DEFAULT TRUE
);

-- The current-standing read is DISTINCT ON (case_type, case_key) ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS physician_standing_case_idx
  ON physician_standing (case_type, case_key, created_at DESC);
