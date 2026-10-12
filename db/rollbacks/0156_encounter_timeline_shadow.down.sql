-- Down-migration for 0156_encounter_timeline_shadow.sql (epic #23 f). RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Drops only the two tables 0156 created. Deletes shadow rows only (no audio and no transcript is stored there).
BEGIN;
DROP TABLE IF EXISTS encounter_timeline_shadow;
DROP TABLE IF EXISTS encounter_timeline_shadow_run;
DELETE FROM schema_migrations WHERE version = 156;
COMMIT;
