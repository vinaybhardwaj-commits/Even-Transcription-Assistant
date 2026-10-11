-- Down-migration for 0156_freescript.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Touches nothing outside the FreeScript objects created by 0156. Deletes stored artifacts only (no transcript is stored there).
BEGIN;
DROP VIEW IF EXISTS freescript_latest;
DROP TABLE IF EXISTS freescript_artifact;
DROP TABLE IF EXISTS freescript_run;
DELETE FROM schema_migrations WHERE version = 156;
COMMIT;
