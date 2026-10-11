-- =====================================================================
-- Migration 0153 — TS-H5/H6/H9: what the room app reports about its helper, on the bench poll.
--
-- WHY. The privileged helper has no server credential for telemetry, so there is NO helper heartbeat. Everything the server learns about the helper and about the power
-- schedule arrives on the app's own bench poll (GET /api/bench/commands, the 1.5 s poll the app already makes), written onto the install's row like the other reported
-- facts. This adds the columns for it. Nothing here sends a command to a Mac; the columns are read-only telemetry shown on Bench and the MCP door.
--
--   helper_version, helper_registration, helper_xpc_ok   what the app last saw of the helper (the poll already carries these three since app 0.1.29)
--   helper_state        'ok' or a short reason code ([a-z_]{1,32}); anything but 'ok' means the helper is not healthy as the app sees it
--   helper_bad_since    server-maintained: when helper_state/helper_xpc_ok FIRST went bad and has stayed bad; NULL while healthy. Not reported by the app.
--   console_user        whether a console (GUI) user was logged in at the last poll that said so
--   power_schedule      e.g. 'MTWRFSU 07:05' (bounded text)
--   pmset_drift         jsonb array of short tokens naming pmset settings that drifted from the baseline (<= 20)
--
-- ADDITIVE AND IDEMPOTENT: ADD COLUMN IF NOT EXISTS only; all nullable; no default, no backfill. NULL = "not reported" (every app below 0.1.35 omits all of them and its polls
-- leave a newer app's last reading where it was, the COALESCE rule of every other poll column). GRANTS: none (app-owned, like room_install).
-- ORDER: apply BEFORE the deploy that carries lib/room-install.ts's helper write; that write is best effort and never fails a poll, but it is silent until the columns exist.
-- =====================================================================

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS helper_version      text,
  ADD COLUMN IF NOT EXISTS helper_registration text,
  ADD COLUMN IF NOT EXISTS helper_xpc_ok       boolean,
  ADD COLUMN IF NOT EXISTS helper_state        text,
  ADD COLUMN IF NOT EXISTS helper_bad_since    timestamptz,
  ADD COLUMN IF NOT EXISTS console_user        boolean,
  ADD COLUMN IF NOT EXISTS power_schedule      text,
  ADD COLUMN IF NOT EXISTS pmset_drift         jsonb;

INSERT INTO schema_migrations (version, name)
VALUES (153, '0153_room_install_helper_fields')
ON CONFLICT DO NOTHING;
