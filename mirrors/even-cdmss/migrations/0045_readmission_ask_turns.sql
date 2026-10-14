-- 0045_readmission_ask_turns.sql — R9 persisted case conversation + the parallel human
-- clinical_review overlay (CDMSS-READMISSIONS-R9-DUAL-CONTRACT-PRD-27-AUG-2026-GO, O3).
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-readmission-ask, which runs this DDL idempotently.
--
-- NO ENGINE BUMP. READMIT_ENGINE_VERSION stays 'readmission/0.2': nothing detected,
-- audited or scored changes. This migration adds storage for a conversation and for a
-- human judgement that sits BESIDE the agent's, never on top of it.
--
-- readmission_ask_turns — one row per TURN of the case Ask box, keyed
-- (dedup_key, engine_version, turn_index). O1 makes the SERVER the thread's truth: the
-- route loads the thread from here and ignores any history the client passes.
--   role         'user' | 'agent'
--   content      already de-identified on arrival (R43-8, extended to stored turns)
--   actor        the care identity from the cookie, on the user's turns
--   withheld     an agent turn that failed its citation check. KEPT — "the agent could
--                not answer that" is part of the record — and never replayed to the model.
--   overlay_json the raw overlay the model reported for that turn, gated or not. It is
--                the audit trail for what the gate REFUSED as much as for what it let in.
--
-- clinical_review_* on readmission_findings (D14) — nine nullable columns, not a jsonb
-- blob, because the board must filter on `decision`. Latest stated assertion wins the
-- columns; the whole history stays in the turns table. These columns are NEVER read by
-- computeIncidence or computeRates (acceptance #6), and this migration does not touch
-- avoidable / planned / same_condition / preventable_injury / negligence.

CREATE TABLE IF NOT EXISTS readmission_ask_turns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedup_key       TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  turn_index      INT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  actor           TEXT,
  withheld        BOOLEAN NOT NULL DEFAULT FALSE,
  overlay_json    JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS readmission_ask_turns_key_idx
  ON readmission_ask_turns (dedup_key, engine_version, turn_index);

ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_decision TEXT;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_clock_class TEXT;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_lt24h_kind TEXT;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_exclusion_claim TEXT;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_quote TEXT;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_actor TEXT;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_at TIMESTAMPTZ;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_turn_id TEXT;
ALTER TABLE readmission_findings ADD COLUMN IF NOT EXISTS clinical_review_model TEXT;
CREATE INDEX IF NOT EXISTS readmission_findings_clinical_review_idx
  ON readmission_findings (engine_version, clinical_review_decision);
