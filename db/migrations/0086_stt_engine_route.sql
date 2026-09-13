-- =====================================================================
-- Migration 0086 — the `route` stt_engine row that 0084 assumed existed.
--
-- WHY. 0084 pointed both room routing rows at `route`, and C1 registered the `route` adapter in
-- code, but nothing ever added the ENGINE ROW. resolveRouting (lib/stt/routing.ts) honours a
-- routing override only if `stt_engine.enabled` is true for that id AND a code adapter exists, so
-- with no row it returned NULL and every room window would have failed `no_engine`. 0084 therefore
-- did not make room STT "free, on the Mini" — it made room STT resolve to nothing. This row is what
-- turns the routing pointer into an engine.
--
-- THE KEY MUST BE `route`, IN BOTH COLUMNS. `id` is what stt_routing.engine_id points at and what
-- resolveRouting looks up; `adapter_key` is what fan-out passes to adapterFor(). The adapter is
-- registered under `route` (lib/stt/registry.ts, ROUTE_ADAPTER_KEY). A different spelling here
-- would move the no_engine failure rather than fix it. Proved by a test that runs resolveRouting
-- against this row, not by reading this comment.
--
-- NOT PAID. It runs on our own hardware: is_paid FALSE, cost_per_min_usd 0. is_paid is the fact the
-- paid-engine guard reads; the cost column is NULL for every paid engine and must never be the
-- signal.
--
-- SHAPE follows gemini's row (0073): the same columns, and capabilities_json with the same six keys.
-- The capability VALUES are the adapter's own declaration (lib/stt/adapters/route.ts), so the
-- registry and the table cannot disagree about what this engine is.
--
-- fanout_enabled FALSE, deliberately. Fan-out now runs free engines by default (allowPaid defaults
-- false since C1b), and this engine is free — so `true` would silently add the Mini's router to
-- every processed encounter on the live doctor path. That is a decision of its own, not a side
-- effect of making room routing resolve.
--
-- ADDITIVE AND IDEMPOTENT. ON CONFLICT (id) DO NOTHING. No routing row is touched (0084 did that).
-- Not added: an stt_engine_family row for `route`. Its family is genuinely mixed (it dispatches
-- spans to whisper, indicconformer and sravaani), and choosing one is a scoring decision.
-- =====================================================================

INSERT INTO stt_engine
  (id, display_name, adapter_key, capabilities_json,
   enabled, fanout_enabled, is_paid, cost_per_min_usd, config_json, sort_order)
VALUES
  ('route', 'Route (per-segment language router, Mac Mini)', 'route',
   '{"tiers":["asr"],"stages":["room","live","note"],"languages":["multi"],"streaming":false,"translates":true,"async":true}'::jsonb,
   true, false, false, 0,
   '{"base_env":"ETA_ROUTER_URL","job_kill_switch_env":"ETA_ROUTER_JOB","note":"free, on-prem: per-span language routing across whisper / indicconformer / sravaani; long form via /route/job submit-and-poll"}'::jsonb,
   80)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (86, '0086_stt_engine_route')
ON CONFLICT DO NOTHING;
