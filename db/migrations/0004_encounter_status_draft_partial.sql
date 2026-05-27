-- =====================================================================
-- Migration 0004 — extend encounter_status with 'draft_partial'
--
-- Reason: Sprint 6.3 introduces a per-encounter cancel button (PRD §8.1.6).
-- When the doctor cancels mid-process, V's locked decision (Q2, 27 May 2026)
-- is to SALVAGE any partial note_json / cdmss_json that completed before
-- the abort, and flip the encounter to a new 'draft_partial' state. The
-- detail page renders a banner offering Re-process or Use-as-is on
-- encounters in this state.
--
-- ALTER TYPE ADD VALUE IF NOT EXISTS is idempotent in PG12+ and safe
-- inside a transaction so long as the new value isn't USED in the same
-- tx (it isn't here — this migration only adds the enum value; encounter
-- rows continue using existing values until application code starts
-- writing 'draft_partial' after deploy).
-- =====================================================================

ALTER TYPE encounter_status ADD VALUE IF NOT EXISTS 'draft_partial';

INSERT INTO schema_migrations (version, name) VALUES (4, '0004_encounter_status_draft_partial') ON CONFLICT DO NOTHING;
