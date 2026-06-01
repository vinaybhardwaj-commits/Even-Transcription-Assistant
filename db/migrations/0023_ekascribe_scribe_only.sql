-- =====================================================================
-- Migration 0023 — EkaScribe is scribe-only on this account.
-- Diagnosis (1 Jun 2026): eka.care silently DROPS transcript_template (raw
-- ASR) for our account — a status=200 returns only clinical_notes_template +
-- eka_emr_template. So the ASR tier always failed with no_output_for_template
-- while the scribe tier works. Drop the 'asr' capability so the ASR fan-out +
-- leaderboard no longer select EkaScribe, and delete the stale failed ASR run.
-- EkaScribe competes on the Scribe tier (clinical_notes_template) vs even_pipeline.
-- =====================================================================
UPDATE stt_engine
   SET capabilities_json = jsonb_set(capabilities_json, '{tiers}', '["scribe"]'::jsonb)
 WHERE id = 'ekascribe';

DELETE FROM transcription_run
 WHERE engine = 'ekascribe' AND tier = 'asr';

INSERT INTO schema_migrations (version, name) VALUES (23, '0023_ekascribe_scribe_only') ON CONFLICT DO NOTHING;
