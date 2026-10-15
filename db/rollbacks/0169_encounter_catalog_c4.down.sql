-- Down-migration for 0169_encounter_catalog_c4.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Drops only the three columns 0169 added (jev, clef_affect, presence; the constraints go with them) and its schema_migrations row. 0168 and every other column are untouched.
-- The columns hold ids, tokens and scores only; newcat's upsert job and the box feed re-derive them.
BEGIN;
ALTER TABLE encounter_catalog DROP COLUMN IF EXISTS jev, DROP COLUMN IF EXISTS clef_affect, DROP COLUMN IF EXISTS presence;
DELETE FROM schema_migrations WHERE version = 169;
COMMIT;
