-- 0009_care_track_assignments.sql — CCB v2 track lifecycle state (owned by CAT in Neon).
-- Idempotent; also created at runtime by ensureCareTrackTables() (/api/admin/migrate-care-tracks).
-- The read-only Pulse forms (individuals-health_forms, db13) are the SOURCE; this table is the
-- assignment/archive/transfer STATE. Unassigned-pool model: opened_by/closed_by are audit only.

CREATE TABLE IF NOT EXISTS care_track_assignments (
  id                 text PRIMARY KEY,
  individual_uid     text NOT NULL,
  track              text NOT NULL,                 -- fever|posthosp|aihs|referral|radiology|postipd|engagement|unknown
  status             text NOT NULL DEFAULT 'active',-- active|archived
  anchor_ref         text,                          -- prescription_uid / episode anchoring this track episode
  opened_at          timestamptz NOT NULL DEFAULT now(),
  opened_by          text,
  closed_at          timestamptz,
  closed_by          text,
  close_reason       text,                          -- recovered|completed|transferred|no_longer_needed|other
  next_assignment_id text,                          -- transfer chain → the successor assignment
  notes              text,
  app_source         text NOT NULL DEFAULT 'standalone'
);

CREATE INDEX IF NOT EXISTS idx_cta_member ON care_track_assignments (individual_uid, status);

-- One ACTIVE assignment per member + track + anchor → assign is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cta_active
  ON care_track_assignments (individual_uid, track, coalesce(anchor_ref,'')) WHERE status = 'active';
