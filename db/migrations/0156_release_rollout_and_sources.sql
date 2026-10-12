-- =====================================================================
-- Migration 0156 — TS-H8 (#45) / TS-H12 (#49) for room app 0.1.37.
--
--  1. fleet_release_rollout   which version of the whole room bundle (the pkg the root helper installs) is open to which group of Macs. ONE row per (version, channel), written
--                             only by an admin action (POST /api/admin/fleet/releases/rollout, audited in fleet_audit). No row = the version is offered to NOBODY by the helper path.
--                             Nothing advances a rollout by itself: there is no cron, worker or timer that touches this table.
--  2. fleet_device_cohort     which named cohort(s) a registered device belongs to (home_office · audiometry · opd1). Admin action only, audited.
--  3. room_install.helper_update_step / _version / _result   what the app reports on its bench poll about the helper's update attempt (display only).
--  4. kiosk_health_events: the dedupe key now includes `source`. The helper and the standalone daemon each count their own `seq` per `boot_id`; with (machine, boot_id, seq) alone a
--     helper event could be swallowed as a "duplicate" of a daemon event that merely shared those three values. The constraint KEEPS ITS NAME, so code that names it
--     (ON CONFLICT ON CONSTRAINT kiosk_health_events_machine_boot_seq_key) works before and after this migration, in either deploy order.
--
-- ADDITIVE AND IDEMPOTENT: CREATE ... IF NOT EXISTS and ADD COLUMN IF NOT EXISTS; the constraint swap is guarded (skipped when the constraint already includes `source`). No data is
-- changed or removed. The constraint swap builds one unique index over kiosk_health_events (30 days of rows) and briefly blocks writes to it while it builds.
-- GRANTS: none (app-owned). NO PHI: version strings, URLs of our own release blobs, machine/device ids.
-- =====================================================================

CREATE TABLE IF NOT EXISTS fleet_release_rollout (
  version      text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('stable', 'test')),
  pkg_url      text NOT NULL,
  pkg_sha256   text NOT NULL CHECK (pkg_sha256 ~ '^[0-9a-f]{64}$'),
  pkg_size     bigint NOT NULL CHECK (pkg_size > 0 AND pkg_size <= 419430400),
  min_helper   text NOT NULL DEFAULT '0.2.0',
  cohort       text NOT NULL CHECK (cohort IN ('home_office', 'audiometry', 'opd1', 'pct', 'all')),
  rollout_pct  integer NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  set_by       text NOT NULL,
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, channel)
);

CREATE TABLE IF NOT EXISTS fleet_device_cohort (
  device_id    text NOT NULL REFERENCES fleet_devices (device_id),
  cohort       text NOT NULL CHECK (cohort IN ('home_office', 'audiometry', 'opd1')),
  assigned_by  text NOT NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, cohort)
);

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS helper_update_step    text,
  ADD COLUMN IF NOT EXISTS helper_update_version text,
  ADD COLUMN IF NOT EXISTS helper_update_result  text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'kiosk_health_events_machine_boot_seq_key' AND c.conrelid = 'kiosk_health_events'::regclass
       AND array_length(c.conkey, 1) = 3
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS kiosk_health_events_machine_boot_seq_source_uidx ON kiosk_health_events (machine, boot_id, seq, source);
    ALTER TABLE kiosk_health_events DROP CONSTRAINT kiosk_health_events_machine_boot_seq_key;
    ALTER TABLE kiosk_health_events ADD CONSTRAINT kiosk_health_events_machine_boot_seq_key UNIQUE USING INDEX kiosk_health_events_machine_boot_seq_source_uidx;
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (156, '0156_release_rollout_and_sources')
ON CONFLICT DO NOTHING;
