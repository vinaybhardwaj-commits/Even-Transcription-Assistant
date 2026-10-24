-- Down-migration for 0177_spine_tick_breaker_idx.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Drops the breaker-read index; no data is touched (the breaker read still works off spine_tick_at_idx).
BEGIN;
DROP INDEX IF EXISTS spine_tick_kind_at_idx;
DELETE FROM schema_migrations WHERE version = 177 AND name = '0177_spine_tick_breaker_idx';
COMMIT;
