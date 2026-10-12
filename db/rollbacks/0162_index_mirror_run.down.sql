-- Down-migration for 0162_index_mirror_run.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
BEGIN;
DROP TABLE IF EXISTS index_mirror_run;
DELETE FROM schema_migrations WHERE version = 162;
COMMIT;
