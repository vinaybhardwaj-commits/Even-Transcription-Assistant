-- Down-migration for 0173_spine.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Touches nothing outside the objects created by 0173. The spine tables hold ids, times and states only; the sources re-derive them.
BEGIN;
DROP TABLE IF EXISTS spine_tick;
DROP TABLE IF EXISTS spine_config;
DROP TABLE IF EXISTS spine_job;
DROP TABLE IF EXISTS spine_artefact;
DROP TABLE IF EXISTS spine_link;
DROP TABLE IF EXISTS spine_encounter;
DROP TABLE IF EXISTS spine_signal;
DELETE FROM schema_migrations WHERE version = 173 AND name = '0173_spine';
COMMIT;
