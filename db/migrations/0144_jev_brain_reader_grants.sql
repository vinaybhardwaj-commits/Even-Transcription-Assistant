-- =====================================================================
-- 0144 — brain_svc SELECT on the tables the Jev MCP readers touch (Jev P0 #56)
--
-- WHY. scribe_jev_decisions and scribe_jev_signals (and the fuse jev arm) read through the BRAIN
-- pool (lib/brain/db, role brain_svc). The jev_* tables were created app-owned with "no GRANTs"
-- (0105, 0106, 0107, 0116), so every read failed 42501 and the tools answered a bare failure.
--
-- THE SWEEP (every table a brain-pool Jev reader names):
--   jev_window_signal  scribe_jev_signals (lib/mcp/tools/jev.ts), jev signals in lib/mcp/tools/fuse.ts
--   jev_decision       scribe_jev_decisions -> listJevDecisions (lib/room-access/tool-reads.ts)
--   jev_window_text    named by the order; no brain-pool reader today, granted for the J-tools
--   room_day           already SELECT-able by brain_svc (0053/0065): nothing to do.
-- NOT granted: bench_window and room_diarize_window — 0074's intent stands: brain_svc does not read room
-- tables. listJevDecisions used to join them for held-out NOT EXISTS clauses; the blind rule is lifted
-- (V, 10 Oct), the clauses are gone, and so is the need.
-- NOT granted either: jev_role_signal (no brain-pool reader).
--
-- GRANT-ONLY AND IDEMPOTENT. SELECT only: brain_svc gains no INSERT, UPDATE or DELETE. No data
-- change. Wrapped as 0053 is: a database without the role (local, CI) is a notice, not an error.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc') THEN
    RAISE NOTICE '0144: role brain_svc does not exist here — nothing granted (expected on a database that does not serve the brain)';
    RETURN;
  END IF;
  GRANT SELECT ON TABLE jev_window_signal TO brain_svc;
  GRANT SELECT ON TABLE jev_decision TO brain_svc;
  GRANT SELECT ON TABLE jev_window_text TO brain_svc;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (144, '0144_jev_brain_reader_grants')
ON CONFLICT DO NOTHING;
