-- 0059_triage_queue_disposition.sql — non-clinical Action-queue outcomes.
--
-- Hold and drop_informational clear the untriaged Action queue by appending a type
-- row that buildQueue overlays. disposition is the outcome (hold | drop_informational).
-- validity on those rows is the application literal non_clinical, which is outside
-- valid_signal | audit_bug, so signal-health and the governance mint do not train on it.
--
-- CREATE / ALTER only. No DROP. Does not set TRIAGE_BOT_WRITE. Does not touch
-- opd_gov_signal. The store also runs this ALTER before it reads or writes the column.

ALTER TABLE opd_audit_triage ADD COLUMN IF NOT EXISTS disposition text;
