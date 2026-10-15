-- =====================================================================
-- Migration 0169 — encounter catalog C4: Jev, Clef (affect) and Presence layers (ORDER 23N; plan ~/oc/palimpsest/CATALOG-C4-PLAN-15OCT.md).
--
-- WHAT. Three nullable jsonb columns on encounter_catalog (0168), each an object or NULL:
--   presence     {encounter_open, encounter_close (UTC ms), boundary_source, close_reason (tokens)}      <- the lab box feed (consult_ledger, catalog_version 2)
--   jev          {sets: [{set_id, set_sha, band, label, model, at}]}                                      <- newcat-lead's upsert job, after each Jev run
--   clef_affect  {lanes: [{lane, scores, model_rev, at}]}                                                 <- newcat-lead's upsert job, after each affect run
-- Written through the existing POST /api/encounter-catalog/ingest as FIELD-LEVEL upserts (a row updates only the columns whose key it carries), returned
-- by GET /api/encounter-catalog/search to admins only. The ingest validates each shape strictly (ids, tokens, scores, instants only) and refuses any key
-- named text / transcript / note / content at any depth; question text and reasons are never stored here.
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS (the inline CHECK is skipped with its column on a re-run). No existing column, row or index is altered.
-- GRANTS: none (app-owned, like 0168). Down-migration: db/rollbacks/0169_encounter_catalog_c4.down.sql (by hand, never from here).
-- =====================================================================

BEGIN;

ALTER TABLE encounter_catalog
  ADD COLUMN IF NOT EXISTS jev         jsonb CONSTRAINT encounter_catalog_jev_chk         CHECK (jev IS NULL OR jsonb_typeof(jev) = 'object'),
  ADD COLUMN IF NOT EXISTS clef_affect jsonb CONSTRAINT encounter_catalog_clef_affect_chk CHECK (clef_affect IS NULL OR jsonb_typeof(clef_affect) = 'object'),
  ADD COLUMN IF NOT EXISTS presence    jsonb CONSTRAINT encounter_catalog_presence_chk    CHECK (presence IS NULL OR jsonb_typeof(presence) = 'object');

COMMENT ON COLUMN encounter_catalog.jev IS 'Jev decisions per question set (0169): ids, set sha, band/label tokens, model, instant. No question text, no reasons.';
COMMENT ON COLUMN encounter_catalog.clef_affect IS 'Clef affect lanes (0169): lane token, numeric scores, model rev, instant.';
COMMENT ON COLUMN encounter_catalog.presence IS 'Pulse Presence boundaries (0169): encounter open/close UTC ms, boundary_source and close_reason tokens.';

INSERT INTO schema_migrations (version, name)
VALUES (169, '0169_encounter_catalog_c4')
ON CONFLICT DO NOTHING;

COMMIT;
