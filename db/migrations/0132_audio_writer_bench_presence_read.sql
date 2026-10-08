-- =====================================================================
-- Migration 0132 — eta_audio_writer may READ bench level/listener/session, room_install and pulse_presence_events
-- (GATING, 8 Oct 2026, for the Rooms Live v1.4 acceptance replay).
--
-- WHY. The Rooms Live v1.4 debugger could not reconstruct the 11:30-12:15 level series or the presence rows behind the
-- wrong-doctor display, because the read-only role used by box agents has no SELECT on these tables. The v1.4 refuter must
-- replay real level series read-only. SELECT only: no INSERT, UPDATE or DELETE, nothing on steward_* tables.
-- Internal role, internal data (V ruling: no PHI gating for EVEN-physician systems). Role stays NOLOGIN in git.
--
-- APPLY AFTER 0129 (eta_audio_writer). ADDITIVE AND IDEMPOTENT: re-granting is a no-op.
-- =====================================================================

GRANT SELECT ON bench_level_sample TO eta_audio_writer;
GRANT SELECT ON bench_listener TO eta_audio_writer;
GRANT SELECT ON bench_session TO eta_audio_writer;
GRANT SELECT ON room_install TO eta_audio_writer;
GRANT SELECT ON pulse_presence_events TO eta_audio_writer;

INSERT INTO schema_migrations (version, name)
VALUES (132, '0132_audio_writer_bench_presence_read')
ON CONFLICT DO NOTHING;
