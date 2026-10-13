-- =====================================================================
-- Migration 0167 — fleet operator-approved one-time re-key (gating/fleet-rekey, 14 Oct 2026; Fable amendment B2/A1/A2). Number assigned by gating-lead (0166 is buddy/l1-ingest-relay).
--
-- WHY. Recorder 0.1.40 mints a new fleet key. lib/fleet/register.ts refuses a different key for an install (409 KEY_CONFLICT) so that a leaked room JWT alone cannot
-- re-key a Mac. That stays the rule. A re-key happens only when an operator has approved THAT install and THAT key fingerprint (pk = base64url SHA-256 of the raw
-- 32-byte public key, the proof's `pk` claim), the approval has not expired (2 hours) and has not been used. The re-key consumes it in the same statement.
--
-- WHAT.
--   fleet_rekey_attempt   one row per (install_id, pk_fingerprint) the register route refused with KEY_CONFLICT: how the operator learns the fingerprint. Upserted,
--                         so it cannot grow per request; the route also keeps only the 20 newest rows per install.
--   fleet_rekey_approval  one row per operator approval: who, when, install, fingerprint, reason, expiry, and how it ended (used_at + outcome 'rekeyed' | 'undone').
--   fleet_devices         status gains 'rotated' (the old row after a re-key) and 'retired' (the new row after an undo); retired_at; approval_id (FK) on the rotated row.
--                         Rows are never deleted. fleet_devices_install_uidx becomes a partial unique index WHERE status = 'active': one ACTIVE device per install.
--
-- ADDITIVE AND IDEMPOTENT. CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS; the status CHECK is dropped by lookup (its generated name is not assumed) and re-added
-- under a fixed name; the index is DROP IF EXISTS + CREATE IF NOT EXISTS.
-- GRANTS: none. Same as 0148 (fleet_*), 0126 and 0128: these tables are APP-OWNED, used only through the app role that runs migrations. The later eta_audio_writer
-- grants (0129, 0130, 0132) are read grants on other tables for a different role and do not apply here.
-- APPLY BEFORE THE CODE IS DEPLOYED: register reads fleet_rekey_approval on every KEY_CONFLICT and writes fleet_rekey_attempt.
-- NO PHI, no names: install ids, device ids, key fingerprints (a hash of a public key), an operator id and a free-text reason of 200 characters.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS fleet_rekey_attempt (
  install_id     text NOT NULL,
  pk_fingerprint text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  attempts       integer NOT NULL DEFAULT 1,
  PRIMARY KEY (install_id, pk_fingerprint)
);

CREATE TABLE IF NOT EXISTS fleet_rekey_approval (
  approval_id    text PRIMARY KEY,
  install_id     text NOT NULL,
  pk_fingerprint text NOT NULL,
  approved_by    text NOT NULL,
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  outcome        text CHECK (outcome IN ('rekeyed', 'undone')),
  old_device_id  text,
  new_device_id  text,
  undone_at      timestamptz,
  undone_by      text,
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX IF NOT EXISTS fleet_rekey_approval_open_idx ON fleet_rekey_approval (install_id, pk_fingerprint, expires_at) WHERE used_at IS NULL;

ALTER TABLE fleet_devices
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_id text REFERENCES fleet_rekey_approval (approval_id);

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
  ADD CONSTRAINT fleet_devices_status_chk CHECK (status IN ('active', 'revoked', 'rotated', 'retired'));

DROP INDEX IF EXISTS fleet_devices_install_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS fleet_devices_install_uidx ON fleet_devices (install_id) WHERE status = 'active';

INSERT INTO schema_migrations (version, name) VALUES (167, '0167_fleet_rekey_approval')
ON CONFLICT (version) DO NOTHING;
COMMIT;
