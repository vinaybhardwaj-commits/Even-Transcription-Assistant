-- Down-migration for 0155_timbre_affect.sql (Architecture #78). RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Touches nothing outside the Timbre objects created by 0155. Deletes derived scores only (no audio/text is stored there).
BEGIN;
DROP VIEW IF EXISTS affect_consult_latest;
DROP TABLE IF EXISTS affect_consult;
DROP TABLE IF EXISTS affect_window;
DROP TABLE IF EXISTS affect_run;
DROP TABLE IF EXISTS affect_calibration_map;
DELETE FROM schema_migrations WHERE version = 155;
COMMIT;
