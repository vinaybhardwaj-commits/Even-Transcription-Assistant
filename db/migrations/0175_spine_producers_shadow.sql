-- =====================================================================
-- Migration 0175 — Spine: seed spine_config so that the producer cron (/api/cron/encounter-shadow, SPINE-P1) runs in SHADOW.
--
-- WHY. The acoustic and timeline shadow runners had no scheduled caller, so the spine read 0 acoustic and 0 timeline signals.
-- WHAT. One row: ('producers', '"shadow"'). DO NOTHING on conflict, so an operator's existing producers value (e.g. "off") is never overwritten.
-- NOT WRITTEN. No kill_switch row, no jobs row, no mode.* row.
-- ADDITIVE AND IDEMPOTENT. No table is created or altered.
-- UNDO. db/rollbacks/0175_spine_producers_shadow.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

INSERT INTO spine_config (key, value)
VALUES ('producers', '"shadow"'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (175, '0175_spine_producers_shadow')
ON CONFLICT DO NOTHING;

COMMIT;
