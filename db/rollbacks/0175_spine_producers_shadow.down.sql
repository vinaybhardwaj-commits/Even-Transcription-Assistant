-- Down-migration for 0175_spine_producers_shadow.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Removes only the producers row if it still holds "shadow" (an operator's other value is left alone), and only its own schema_migrations row.
BEGIN;
DELETE FROM spine_config WHERE key = 'producers' AND value = '"shadow"'::jsonb;
DELETE FROM schema_migrations WHERE version = 175 AND name = '0175_spine_producers_shadow';
COMMIT;
