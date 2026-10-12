-- =====================================================================
-- Migration 0158 — allow eta.freescript.v0.3 on freescript_run.
--
-- WHAT. 0157's schema check listed eta.freescript.v0.1 and v0.2. The pipeline now emits
-- eta.freescript.v0.3. This replaces that check. v0.1 and v0.2 still pass. No row is rewritten.
--
-- ADDITIVE. Drops and recreates one check constraint. GRANTS: none. Down-migration:
-- db/rollbacks/0158_freescript_v03.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

ALTER TABLE freescript_run DROP CONSTRAINT IF EXISTS freescript_run_schema_chk;
ALTER TABLE freescript_run ADD CONSTRAINT freescript_run_schema_chk
  CHECK (schema_version IN ('eta.freescript.v0.1', 'eta.freescript.v0.2', 'eta.freescript.v0.3'));

INSERT INTO schema_migrations (version, name)
VALUES (158, '0158_freescript_v03')
ON CONFLICT DO NOTHING;

COMMIT;
