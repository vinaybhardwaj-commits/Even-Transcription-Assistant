-- 0060_triage_note_class.sql — class on the shared Action queue and Findings pipe.
--
-- Discharge-summary cards join the same opd_audit_triage / opd_gov_signal tables.
-- note_class is opd | discharge_summary | ot. Existing rows default to opd.
-- The previous signal unique index omitted class, so an OPD thread and a
-- discharge thread for the same doctor × signal × window could not both exist.
-- That index is replaced. No row is updated or deleted.
--
-- Does not set TRIAGE_BOT_WRITE. Does not set TRIAGE_BOT_WRITE_CLASSES.
-- Does not enable discharge-summary mint.

ALTER TABLE opd_audit_triage ADD COLUMN IF NOT EXISTS note_class text NOT NULL DEFAULT 'opd';

ALTER TABLE opd_gov_signal ADD COLUMN IF NOT EXISTS note_class text NOT NULL DEFAULT 'opd';

DROP INDEX IF EXISTS opd_gov_signal_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS opd_gov_signal_class_key_idx
  ON opd_gov_signal (
    note_class,
    doctor_uid,
    signal_type,
    coalesce(window_from, '0001-01-01'),
    coalesce(window_to, '0001-01-01')
  );

CREATE INDEX IF NOT EXISTS opd_audit_triage_class_type_idx
  ON opd_audit_triage (note_class, doctor_uid, signal_type, created_at DESC);
