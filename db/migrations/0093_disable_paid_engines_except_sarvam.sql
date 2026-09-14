-- =====================================================================
-- Migration 0093 — D1: the paid STT engines are closed off, except Sarvam.
--
-- WHY. V's ruling, 14 September 2026, executing S8 (ratified 11 September): Sarvam is the only
-- paid API kept; the Mini-based whisper, diarize and emotion stacks are the workhorse; every other
-- paid engine is closed off and silent. This is the DISABLE half only. No adapter, route, test or
-- registry entry is removed here — that is D2, a separate round.
--
-- THE LIST IS THE DECISION, SO THE LIST IS ENCODED. Four engines, by id:
--   deepgram, elevenlabs, elevenlabs_scribe  — paid, were enabled with fan-out on
--   ekascribe                                — paid, already off; asserted so the record is complete
-- There is deliberately no `WHERE is_paid` predicate: that would catch sarvam today and silently
-- catch any paid engine added later. Not touched: sarvam (the one paid engine kept), whisper,
-- indicconformer, indicconformer_scribe, route, even_pipeline, and gemini (already off, 0091).
--
-- ⚠ THE ROW IS A PARTIAL CONTROL (D1 C26, recorded in ETA-D1-CLOSE-PAID-ENGINES-REPORT-14-SEP-2026).
-- The offline fan-out (lib/stt/fanout.ts), routing (lib/stt/routing.ts) and the scribe tier read
-- `enabled` / `fanout_enabled` and skip these engines. These do NOT read the row and keep calling:
--   Deepgram — the browser live consult (deepgram-token route, env DEEPGRAM_API_KEY); the encounter
--   process route's diarized batch; both voice transcribe-window routes; an MCP transcribe_range
--   call that names the engine explicitly.
--   Health — the MCP and STT Lab health probes call every adapter's health(), disabled or not.
-- Closing those is application code, a separate round. This migration does not close them.
--
-- RE-ENABLING one engine: set enabled and fanout_enabled back to true for that id, by id —
--   UPDATE stt_engine SET enabled = true, fanout_enabled = true WHERE id = '<engine id>';
--
-- IDEMPOTENT. The UPDATE matches only a listed row that still has either flag on, so a re-run changes
-- nothing and does not error. A listed id with no row matches nothing.
-- =====================================================================

UPDATE stt_engine
   SET enabled = false,
       fanout_enabled = false
 WHERE id IN ('deepgram', 'elevenlabs', 'elevenlabs_scribe', 'ekascribe')
   AND (enabled = true OR fanout_enabled = true);

INSERT INTO schema_migrations (version, name)
VALUES (93, '0093_disable_paid_engines_except_sarvam')
ON CONFLICT DO NOTHING;
