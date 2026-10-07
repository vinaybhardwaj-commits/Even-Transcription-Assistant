-- =====================================================================
-- Migration 0130 — eta_audio_writer may READ kiosk_health_events (CONSULT request, 7 Oct 2026).
--
-- WHY. The room audio-state classifier labels kiosk minutes from kiosk-health evidence (audio.devices, display.state, power.sleep/wake,
-- recorder.log) and today it cannot read that table. SELECT only: no INSERT, UPDATE or DELETE on kiosk_health_events, and nothing on
-- steward_decisions, steward_config or any other table. The role stays NOLOGIN in git; the password is set outside git.
--
-- APPLY AFTER 0126 (kiosk_health_events) and 0129 (eta_audio_writer). ADDITIVE AND IDEMPOTENT: re-granting is a no-op.
-- =====================================================================

GRANT SELECT ON kiosk_health_events TO eta_audio_writer;

INSERT INTO schema_migrations (version, name)
VALUES (130, '0130_audio_writer_kiosk_health_read')
ON CONFLICT DO NOTHING;
