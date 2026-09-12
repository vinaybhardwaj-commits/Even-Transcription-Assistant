-- =====================================================================
-- Migration 0084 — Tier 2 Slice C1, step 6: room audio moves to the `route` engine.
--
-- ⚠ READ THE BLOCKER BELOW BEFORE APPLYING THIS FILE. ⚠
--
-- WHY THE SWITCH. ETA transcribes Kannada/Hindi/English OPD consultations through an English-only
-- model. That is wrong by construction, not by measurement — and it cannot be settled by
-- measurement, because the Indic gold corpus that would settle it does not exist (stt_gold: 3 rows,
-- 0 Indic) and cannot be built by writing code. V's ruling: switch on the prior, and make the prior
-- cheap to disprove. The four tripwires (scribe_route_tripwires) and the shadow runs are that.
--
-- ─── BLOCKER FOUND DURING THE BUILD — THIS IS NOT SAFE TO APPLY ON ITS OWN ─────────────────────
-- A room window is FIFTEEN MINUTES (lib/bench-window.ts:84, WINDOW_MS = 15 * 60 * 1000).
-- The drain transcribes a window INLINE, inside one request, and that route's ceiling is 300 s
-- (app/api/admin/bench/drain/route.ts:26, maxDuration = 300).
-- The router runs at roughly 1.3x realtime measured with translation OFF, so 900 s of audio is
-- about 1170 s of work — nearly FOUR TIMES the entire ceiling.
--
-- So with this migration applied and nothing else changed, every room window would:
--   1. resolve to `route`,
--   2. hit the adapter's own duration guard and come back `route_sync_limit_exceeded`,
--   3. be recorded as `engine_failed` and retried,
--   4. and — once the drain is taught to use the async job instead — resubmit on every retry,
--      because the router has no idempotency key. That is duplicated twenty-minute jobs on the
--      Mini, which is worse than the inert outcome the tripwires were built to detect.
--
-- The missing piece is not in this file: the drain must ENQUEUE a `route_transcribe` job and write
-- the run when it completes, instead of calling adapter.transcribe() inline. That is a control-flow
-- change to lib/stt/room-drain.ts that this slice's order did not cover, so it is reported rather
-- than improvised. APPLY 0084 ONLY AFTER THAT LANDS.
--
-- Everything else in C1 is already useful without this file: 0083's safety net, the adapter, the
-- job kind (reachable today through the MCP job path), the timeline persistence, the tripwires and
-- the shadow runs all work while the room rows still say `sarvam`.
--
-- ─── THE REVERSAL, WRITTEN DOWN BEFORE THE SWITCH ─────────────────────────────────────────────
-- No deploy, no migration, no code change. Two UPDATEs:
--
--   UPDATE stt_routing SET engine_id = 'sarvam', updated_at = now()
--    WHERE stage = 'room' AND language_bucket = 'english';
--   UPDATE stt_routing SET engine_id = 'sarvam', updated_at = now()
--    WHERE stage = 'room' AND language_bucket = 'indic';
--
-- 0083's (room,'default') row means even a DELETE of both rows falls back to sarvam rather than
-- failing every window with no_engine. That is the whole reason it was applied first.
-- =====================================================================

UPDATE stt_routing SET engine_id = 'route', updated_at = now()
 WHERE stage = 'room' AND language_bucket = 'english';

UPDATE stt_routing SET engine_id = 'route', updated_at = now()
 WHERE stage = 'room' AND language_bucket = 'indic';

INSERT INTO schema_migrations (version, name)
VALUES (84, '0084_stt_routing_room_to_route')
ON CONFLICT DO NOTHING;
