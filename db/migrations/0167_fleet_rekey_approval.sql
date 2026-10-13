-- =====================================================================
-- Migration 0167 — fleet operator-approved one-time re-key (gating/fleet-rekey, 14 Oct 2026). Number assigned by gating-lead (0166 is buddy/l1-ingest-relay).
--
-- WHY. Recorder 0.1.40 mints a new fleet key. lib/fleet/register.ts refuses a different key for an install (409 KEY_CONFLICT) so that a leaked room JWT alone
-- cannot re-key a Mac. That stays the rule. A re-key now happens only after an operator approves it: POST /api/admin/installs/{id}/allow-rekey sets
-- room_install.rekey_allowed_until (now + 2 hours) and rekey_allowed_by. A registration with a different key, a valid room JWT and a valid proof of possession
-- is accepted ONCE inside that window; the same statement clears both columns.
--
-- WHAT.
--   room_install.rekey_allowed_until  timestamptz  null = no approval
--   room_install.rekey_allowed_by     text         the admin actor that approved
--   fleet_devices.status              gains 'rotated' (the old row after a re-key; never deleted; rotated_at already exists from 0148)
--   fleet_devices_install_uidx        becomes a partial unique index WHERE status = 'active': one ACTIVE device per install, old rows kept as history
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS; the status CHECK is dropped by lookup (its generated name is not assumed) and re-added under a fixed name;
-- the index is DROP IF EXISTS + CREATE IF NOT EXISTS. GRANTS: none change (app-owned tables).
-- APPLY BEFORE THE CODE IS DEPLOYED: the new register path writes status 'rotated' and reads the new columns.
-- =====================================================================
BEGIN;

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS rekey_allowed_until timestamptz,
  ADD COLUMN IF NOT EXISTS rekey_allowed_by text;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'fleet_devices'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE fleet_devices DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE fleet_devices
  ADD CONSTRAINT fleet_devices_status_chk CHECK (status IN ('active', 'revoked', 'rotated'));

DROP INDEX IF EXISTS fleet_devices_install_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS fleet_devices_install_uidx ON fleet_devices (install_id) WHERE status = 'active';

INSERT INTO schema_migrations (version, name) VALUES (167, '0167_fleet_rekey_approval')
ON CONFLICT (version) DO NOTHING;
COMMIT;
