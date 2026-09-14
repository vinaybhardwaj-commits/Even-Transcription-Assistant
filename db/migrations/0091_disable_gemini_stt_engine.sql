-- =====================================================================
-- Migration 0091 — S1 FIX2 (C4): the `gemini` stt_engine row is disabled.
--
-- WHY. Two sources of truth disagreed about whether Gemini is on. 0073 seeded the row with
-- `enabled = true`, while the GEMINI_STT env gate keeps the engine off: its adapter's health answers
-- `gemini_stt_disabled` whenever the gate is off (lib/stt/adapters/gemini.ts:345). scribe_health
-- requires every enabled, non-virtual engine to be healthy (lib/mcp/tools/health.ts:116), so it
-- counted a permanently failing engine and could never report ok, however healthy the Mini was.
--
-- The fix is the row, not a special case in health.ts: special-casing a gate would keep the
-- disagreement and add a second rule to keep in step.
--
-- RE-ENABLING. Turn the row AND the gate on together, never one alone:
--
--   UPDATE stt_engine SET enabled = true WHERE id = 'gemini';   -- and set GEMINI_STT in the environment
--
-- The row alone brings the health red back; the gate alone leaves the engine unselectable.
--
-- IDEMPOTENT. The UPDATE matches only a row that is still enabled, so a re-run changes nothing and
-- does not error. A database with no `gemini` row matches nothing either.
--
-- NOT TOUCHED: fanout_enabled (already false, 0073), stt_routing, every other engine row.
-- =====================================================================

UPDATE stt_engine
   SET enabled = false
 WHERE id = 'gemini'
   AND enabled = true;

INSERT INTO schema_migrations (version, name)
VALUES (91, '0091_disable_gemini_stt_engine')
ON CONFLICT DO NOTHING;
