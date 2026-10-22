-- =====================================================================
-- Migration 0174 — Spine: seed spine_config so that spine ingest runs in SHADOW.
--
-- WHY. Prod is at 0173. The spine cron (/api/cron/spine, S1) is a no-op until spine_config has ingest = shadow, and no prod DB URL exists outside Vercel,
--   so the row goes in through the migration runner.
-- WHAT. One row: ('ingest', '"shadow"'). DO NOTHING on conflict, so an operator's existing ingest value (e.g. "off") is never overwritten.
-- NOT WRITTEN. No kill_switch row, no jobs row, no mode.* row. A missing value means off (lib/spine/config.ts), so the queue and every stage stay off.
-- NUMBER. 0174 was free on origin/main and on every live remote branch when this was written.
-- ADDITIVE AND IDEMPOTENT. No table is created or altered.
-- UNDO. db/rollbacks/0174_spine_ingest_shadow.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

INSERT INTO spine_config (key, value)
VALUES ('ingest', '"shadow"'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (174, '0174_spine_ingest_shadow')
ON CONFLICT DO NOTHING;

COMMIT;
