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
--   bench_window, room_diarize_window
--                      joined by listJevDecisions' held-out NOT EXISTS clauses; Postgres checks
--                      privilege on every relation in the statement, so the join alone 42501s.
--                      NOTE: 0074 deliberately granted brain_svc nothing on room_diarize_window;
--                      this reverses that for SELECT only, at the order's instruction.
--   room_day           already SELECT-able by brain_svc (0053/0065): nothing to do.
-- NOT granted: jev_role_signal (no brain-pool reader).
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
  GRANT SELECT ON TABLE bench_window TO brain_svc;
  GRANT SELECT ON TABLE room_diarize_window TO brain_svc;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (144, '0144_jev_brain_reader_grants')
ON CONFLICT DO NOTHING;
