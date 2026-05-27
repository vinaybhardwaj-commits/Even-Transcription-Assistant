-- =====================================================================
-- Migration 0005 — launch_readiness attestation columns on settings
--
-- Sprint 12 (27 May 2026): the §10.1 launch-day "Audio data loss = 0
-- in tested offline scenarios" criterion is the only one in PRD §10.1
-- that requires a manual test (offline recording → reconnect → confirm
-- 0 audio bytes lost). All other criteria are queryable from existing
-- tables. This migration adds 3 columns to the singleton `settings`
-- row so the admin can attest the manual test passed:
--
--   audio_offline_test_passed BOOLEAN  → toggled by the admin UI
--   audio_offline_test_at     TIMESTAMP → when attestation flipped
--   audio_offline_test_by     UUID      → which admin attested
--
-- The launch-readiness page reads these three to render the row's
-- pass-fail badge. Re-attestation just overwrites the timestamp/by.
-- =====================================================================

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS audio_offline_test_passed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS audio_offline_test_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audio_offline_test_by     UUID;

INSERT INTO schema_migrations (version, name)
VALUES (5, '0005_launch_readiness_attestation')
ON CONFLICT DO NOTHING;
