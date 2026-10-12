-- Down-migration for 0159_freescript_rejected.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Restores the 0157 state check. Fails if a rejected row is already stored.
BEGIN;
ALTER TABLE freescript_run DROP CONSTRAINT IF EXISTS freescript_run_state_chk;
ALTER TABLE freescript_run ADD CONSTRAINT freescript_run_state_chk
  CHECK (state IN ('ok', 'invalid') AND ((state = 'ok') = validator_ok));
DELETE FROM schema_migrations WHERE version = 159;
COMMIT;
