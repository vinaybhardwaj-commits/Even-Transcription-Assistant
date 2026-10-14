-- Down-migration for 0168_encounter_catalog.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Touches nothing outside the object created by 0168. Drops the catalog rows (ids, keys and states only; no transcript is stored there; the box re-derives them from its ledger).
BEGIN;
DROP TABLE IF EXISTS encounter_catalog;
DELETE FROM schema_migrations WHERE version = 168;
COMMIT;
