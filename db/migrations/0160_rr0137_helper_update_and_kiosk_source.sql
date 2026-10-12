-- =====================================================================
-- Migration 0160 — RR 0.1.37: the helper's self-update on the bench poll, and `source` in the kiosk-health unique key.
--
-- (1) room_install.helper_update_step / helper_update_version / helper_update_result: what the app reports about the helper's update (closed tokens, nullable, no default, no
--     backfill; NULL = not reported; COALESCE like the other helper_* columns). GRANTS: none (app-owned, like room_install).
-- (2) kiosk_health_events: the dedupe key was (machine, boot_id, seq). The standalone daemon and the helper each count their own seq, so one source's event could be swallowed as
--     the other's duplicate. The key becomes (machine, boot_id, seq, source). The new unique constraint is added FIRST, then the old one is dropped, so there is never a moment
--     without a unique key. The route's insert names no constraint (ON CONFLICT DO NOTHING), so it is correct before and after this migration.
--
-- LOCKS. The migration runner wraps the file in one transaction, so CREATE UNIQUE INDEX CONCURRENTLY is NOT usable; a plain ADD CONSTRAINT ... UNIQUE builds its index under a lock
-- that blocks writes to kiosk_health_events for the build (30-day retention keeps the table small, but its size was NOT measured: no live DB for this build). SET LOCAL lock_timeout
-- makes the transaction fail fast and roll back rather than queue behind a long writer; re-run when quiet. Down-migration is by hand: re-add the 3-column key, drop the 4-column one.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS helper_update_step    text,
  ADD COLUMN IF NOT EXISTS helper_update_version text,
  ADD COLUMN IF NOT EXISTS helper_update_result  text;

ALTER TABLE kiosk_health_events
  ADD CONSTRAINT kiosk_health_events_machine_boot_seq_source_key UNIQUE (machine, boot_id, seq, source);
ALTER TABLE kiosk_health_events
  DROP CONSTRAINT IF EXISTS kiosk_health_events_machine_boot_seq_key;

INSERT INTO schema_migrations (version, name)
VALUES (160, '0160_rr0137_helper_update_and_kiosk_source')
ON CONFLICT DO NOTHING;

COMMIT;
