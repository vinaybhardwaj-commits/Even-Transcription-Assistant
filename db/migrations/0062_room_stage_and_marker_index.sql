-- =====================================================================
-- Migration 0062 — the 'room' routing stage, and the fifth partial cue index (23 Aug 2026).
--
-- Two additive changes, both required by the room STT drain (K4b). No column is added, no
-- column is dropped, no existing row is rewritten, and nothing here is guarded by a feature
-- flag — a routing row that nothing reads is inert, and an index changes only how fast the
-- same answer is found.
--
-- ─── 1. THE ROOM STAGE ────────────────────────────────────────────────────────────────────
-- The routing matrix is keyed (stage, language_bucket). Stages were ('live','note'): the
-- on-screen transcript during a consultation, and the note generated from it. A room tape is
-- neither. It is a fifteen-minute window of a room, drained after the fact, and it must be
-- routable on its own so that changing the room engine cannot change the engine a doctor sees
-- live. Both rows point at sarvam today; both are editable from the STT lab like any other cell.
--
-- ON CONFLICT DO NOTHING so re-running this migration cannot overwrite an engine an admin has
-- since pinned by hand. The stage vocabulary is ALSO enumerated in TypeScript, and this file is
-- useless without those: app/api/admin/stt-lab/routing/route.ts (STAGES),
-- lib/mcp/tools/stt.ts (the scribe_stt_routing answer, twice) and lib/stt/routing.ts (Stage).
--
-- ─── 2. THE FIFTH PARTIAL INDEX ───────────────────────────────────────────────────────────
-- SQL_LAST_WINDOW_MARKER (lib/admin/rooms-live.ts) reads the newest stt_window cue per room-day
-- for the live operator monitor. It has no dedicated index and rides cue_room_day_at_idx (0042),
-- walking back through the day's cues until it meets an stt_window row.
--
-- That was harmless for one reason only: LIVE ROOM-DAYS CARRIED NO TURN CUES. The turns that
-- exist today were written by the operator door on demand, onto days nobody was watching.
-- THIS BUILD CHANGES THAT. A drained seven-hour room day writes roughly 28 windows' worth of
-- stt_turn rows onto the day the monitor is polling every 20 seconds, so the back-scan grows
-- with the day it is monitoring — slowest exactly when it matters most.
--
-- The shape is 0054's, deliberately: same table, same (room_day_id, at DESC) leading columns,
-- same partial predicate on `type`. 0054 predicted this index in prose ("the fix if it ever
-- bites is a fifth partial index") and rooms-live.ts carries the same note above the query.
-- 'stt_window' is WINDOW_CUE_TYPE in lib/mcp/tools/bench.ts; an index predicate cannot
-- interpolate a TypeScript constant, so it is spelled out here and held in agreement by test.
--
-- NOT TOUCHED: cue_room_day_at_idx and the other four indexes of 0054, every stt_routing row
-- that already exists, and every table's data.
-- =====================================================================

INSERT INTO stt_routing (stage, language_bucket, engine_id) VALUES
  ('room', 'english', 'sarvam'),
  ('room', 'indic',   'sarvam')
ON CONFLICT (stage, language_bucket) DO NOTHING;

CREATE INDEX IF NOT EXISTS cue_window_recent_idx
  ON cue (room_day_id, at DESC)
  WHERE type = 'stt_window';

INSERT INTO schema_migrations (version, name)
VALUES (62, '0062_room_stage_and_marker_index')
ON CONFLICT DO NOTHING;
