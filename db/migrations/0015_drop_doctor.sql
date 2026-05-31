-- =====================================================================
-- Migration 0015 — V2.S8b Phase E: DROP the doctor table. IRREVERSIBLE.
-- Prereqs (all done): clinician holds all rows (S6 backfill), app reads+writes
-- clinician exclusively (S8a + S8b step 1), all FKs repointed to clinician
-- (0014). Neon snapshot taken by V before this runs. clinician is now the sole
-- identity table.
-- =====================================================================
DROP TABLE IF EXISTS doctor;

INSERT INTO schema_migrations (version, name) VALUES (15, '0015_drop_doctor') ON CONFLICT DO NOTHING;
