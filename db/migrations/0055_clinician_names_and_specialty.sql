-- =====================================================================
-- Migration 0055 — clinician.specialty, given_name, family_name (22 Aug 2026).
--
-- Three nullable TEXT columns on `clinician`. Additive, idempotent, and NOTHING
-- IN THIS BUILD WRITES THEM. No reader changes; no default; no backfill.
--
-- full_name STAYS AUTHORITATIVE. given_name/family_name are a place for a name
-- that arrives already split — from a roster, an HR export, an HIS feed — and
-- nowhere else. They are deliberately NOT backfilled by splitting full_name on
-- whitespace: "Dr. Ramesh Kumar Iyer", "P. S. Raghavan" and "Ravi" each split
-- differently and wrongly, and a wrong given_name is worse than a null one
-- because it looks answered. A row with both nulls means "we were never told",
-- which is the truth for every row that exists today.
--
-- specialty is free TEXT with no CHECK on purpose: the specialty vocabulary is
-- not settled, and a closed set here would have to be migrated every time a new
-- clinic onboards. Closing it is a later decision, made against real values.
--
-- NOT TOUCHED: full_name (still NOT NULL), clinician_type and its enum, every
-- index on clinician, and the doctor table.
-- =====================================================================

ALTER TABLE clinician ADD COLUMN IF NOT EXISTS specialty   TEXT;
ALTER TABLE clinician ADD COLUMN IF NOT EXISTS given_name  TEXT;
ALTER TABLE clinician ADD COLUMN IF NOT EXISTS family_name TEXT;

INSERT INTO schema_migrations (version, name)
VALUES (55, '0055_clinician_names_and_specialty')
ON CONFLICT DO NOTHING;
