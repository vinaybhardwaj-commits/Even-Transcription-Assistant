-- =====================================================================
-- Migration 0176 — Spine: widen spine_encounter_status_chk with `confirmed_single_proxy` (fable RULING B, 22 Oct 2026).
--
-- WHY. D4 stays for `confirmed`. A group whose only evidence is one timeline signal (no strong anchor) is a distinct status, never `confirmed`, so its precision can be measured in SHADOW against Pulse-anchored truth.
-- WHAT. DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT with the 5 values. No data change, no seed, no other schema change.
-- IDEMPOTENT. Safe to run twice.
-- UNDO. db/rollbacks/0176_spine_encounter_single_proxy.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

ALTER TABLE spine_encounter DROP CONSTRAINT IF EXISTS spine_encounter_status_chk;
ALTER TABLE spine_encounter ADD CONSTRAINT spine_encounter_status_chk
  CHECK (status IN ('candidate','confirmed','confirmed_single_proxy','rejected','merged'));

INSERT INTO schema_migrations (version, name)
VALUES (176, '0176_spine_encounter_single_proxy')
ON CONFLICT DO NOTHING;

COMMIT;
