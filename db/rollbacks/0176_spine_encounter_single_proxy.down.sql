-- Down-migration for 0176_spine_encounter_single_proxy.sql. RUN BY HAND ONLY.
-- Lives in db/rollbacks/ because app/api/run-migrations applies every .sql in db/migrations/.
-- Maps confirmed_single_proxy rows back to candidate (the merge re-derives them), then restores the 4-value CHECK.
BEGIN;
UPDATE spine_encounter SET status = 'candidate' WHERE status = 'confirmed_single_proxy';
ALTER TABLE spine_encounter DROP CONSTRAINT IF EXISTS spine_encounter_status_chk;
ALTER TABLE spine_encounter ADD CONSTRAINT spine_encounter_status_chk CHECK (status IN ('candidate','confirmed','rejected','merged'));
DELETE FROM schema_migrations WHERE version = 176 AND name = '0176_spine_encounter_single_proxy';
COMMIT;
