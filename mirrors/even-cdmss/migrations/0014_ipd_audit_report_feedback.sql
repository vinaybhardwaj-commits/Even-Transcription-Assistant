-- 0014_ipd_audit_report_feedback — S3 surface additions (IPD Discharge Audit).
--
-- 1. ipd_discharge_audits.report — the FULL de-identified AuditReport JSON (completeness items,
--    idealised course + diff, value scorecard, sources), so the report page can reuse the
--    shipped CaseAuditReport renderer without re-running the engine. De-identified by the
--    extract pass's cardinal privacy rule; still no names/UHID anywhere in the row.
-- 2. ipd_audit_feedback — per-finding clinician triage (Agree / Disagree / Needs action) +
--    whole-audit notes. Append-only; mirrors the OPD feedback-table posture (feedback is a
--    separate table so re-audits never clobber it).

ALTER TABLE ipd_discharge_audits ADD COLUMN IF NOT EXISTS report JSONB;

CREATE TABLE IF NOT EXISTS ipd_audit_feedback (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source   TEXT NOT NULL DEFAULT 'standalone',
  audit_id     UUID NOT NULL,          -- ipd_discharge_audits.id (no FK: audits may be re-run/deleted)
  finding_ref  TEXT,                   -- finding subject (null = whole-audit feedback)
  verdict      TEXT NOT NULL,          -- agree | disagree | needs_action
  note         TEXT
);

CREATE INDEX IF NOT EXISTS ipd_audit_feedback_audit_idx ON ipd_audit_feedback (audit_id);
