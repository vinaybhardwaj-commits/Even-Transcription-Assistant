-- =====================================================================
-- Migration 0028 — enable IndicConformer fan-out.
-- The Mac-Mini exposed https://indic.llmvinayminihome.uk (Pattern B, verified
-- live). Flip fanout_enabled on for both engines so they participate in the
-- offline fan-out + leaderboard. They no-op (skipped, not persisted) on
-- non-Indic clips, so they only ever compete on the Indic slice.
-- =====================================================================
UPDATE stt_engine SET fanout_enabled = true WHERE id IN ('indicconformer', 'indicconformer_scribe');

INSERT INTO schema_migrations (version, name) VALUES (28, '0028_indicconformer_fanout_on') ON CONFLICT DO NOTHING;
