-- Down-migration for 0167_fleet_rekey_approval.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Restores fleet_devices exactly as 0148 made it: the status CHECK fleet_devices_status_check (active, revoked) and the FULL unique index fleet_devices_install_uidx on
-- (install_id). The full index cannot hold a rotated or retired history row beside an active one, so those rows block the rollback: it stops with an exception and
-- changes nothing. Decide what to do with them first (a rotated or retired row is the record of a re-key; nothing here deletes one).
-- Drops fleet_rekey_approval and fleet_rekey_attempt with their rows: the approval audit trail in those tables goes with them (audit_log and fleet_audit keep theirs).
BEGIN;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM fleet_devices WHERE status IN ('rotated', 'retired');
  IF n > 0 THEN
    RAISE EXCEPTION '0167 down refused: % fleet_devices row(s) are rotated or retired; the full unique index on (install_id) cannot be restored over them', n;
  END IF;
END
$$;
DROP INDEX IF EXISTS fleet_devices_install_uidx;
CREATE UNIQUE INDEX fleet_devices_install_uidx ON fleet_devices (install_id);
ALTER TABLE fleet_devices DROP CONSTRAINT IF EXISTS fleet_devices_status_chk;
ALTER TABLE fleet_devices ADD CONSTRAINT fleet_devices_status_check CHECK (status IN ('active', 'revoked'));
ALTER TABLE fleet_devices DROP COLUMN IF EXISTS approval_id;
ALTER TABLE fleet_devices DROP COLUMN IF EXISTS retired_at;
DROP TABLE IF EXISTS fleet_rekey_approval;
DROP TABLE IF EXISTS fleet_rekey_attempt;
DELETE FROM schema_migrations WHERE version = 167;
COMMIT;
