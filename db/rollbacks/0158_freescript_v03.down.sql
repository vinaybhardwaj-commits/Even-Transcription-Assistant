-- Down-migration for 0158_freescript_v03.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Restores the 0157 check (v0.1 and v0.2 only). Fails if a v0.3 row is already stored.
BEGIN;
ALTER TABLE freescript_run DROP CONSTRAINT IF EXISTS freescript_run_schema_chk;
ALTER TABLE freescript_run ADD CONSTRAINT freescript_run_schema_chk
  CHECK (schema_version IN ('eta.freescript.v0.1', 'eta.freescript.v0.2'));
DELETE FROM schema_migrations WHERE version = 158;
COMMIT;
