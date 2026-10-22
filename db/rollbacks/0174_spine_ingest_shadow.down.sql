-- Down-migration for 0174_spine_ingest_shadow.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Removes only the ingest row if it still holds "shadow" (an operator's other value is left alone), and only its own schema_migrations row.
BEGIN;
DELETE FROM spine_config WHERE key = 'ingest' AND value = '"shadow"'::jsonb;
DELETE FROM schema_migrations WHERE version = 174 AND name = '0174_spine_ingest_shadow';
COMMIT;
