-- =====================================================================
-- Migration 0159 — record a rejected FreeScript run.
--
-- WHAT. 0157's state check allowed only ok and invalid. The nightly now posts a
-- validator failure as rejected, with the FRX codes and cost_usd, so a failed
-- consult is visible. ok still requires validator_ok. invalid remains so a row
-- written before this migration still satisfies the check. No row is rewritten.
--
-- ADDITIVE. Drops and recreates one check constraint. GRANTS: none. Down-migration:
-- db/rollbacks/0159_freescript_rejected.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

ALTER TABLE freescript_run DROP CONSTRAINT IF EXISTS freescript_run_state_chk;
ALTER TABLE freescript_run ADD CONSTRAINT freescript_run_state_chk
  CHECK (state IN ('ok', 'invalid', 'rejected') AND ((state = 'ok') = validator_ok));

INSERT INTO schema_migrations (version, name)
VALUES (159, '0159_freescript_rejected')
ON CONFLICT DO NOTHING;

COMMIT;
