-- =====================================================================
-- Migration 0054 — indexes the live operator monitor needs (22 Aug 2026).
--
-- REQUIRED, NOT AN OPTIMISATION. The monitor polls every room every few seconds during a real
-- OPD day. `cue` has no index on `type`, and a clinic day now writes THOUSANDS of stt_turn rows
-- (speech turns slice A), so the two rollup reads below would each scan the whole day's cues for
-- every room on every poll. Without these, the monitor gets slower exactly as the day it is
-- monitoring gets busier — which is the one time it has to work.
--
-- All four are additive, IF NOT EXISTS, and touch no data. None is unique, so none can fail on
-- existing rows the way a unique index can. Two are PARTIAL, and the predicates are chosen to
-- match the monitor's queries exactly:
--
--   bench_session_room_started_idx  the monitor's own session query, which uses a HALF-OPEN
--                                   started_at range so this index is usable. listBenchSessions
--                                   is deliberately NOT changed — its filter wraps the column in
--                                   AT TIME ZONE, which defeats any index on it, and other pages
--                                   depend on its shape and its date semantics.
--   cue_warehouse_recent_idx        MAX(at) over the four warehouse types, per room-day.
--   cue_mark_recent_idx             COUNT + MAX(at) over consult_mark, per room-day.
--   bench_event_session_kind_idx    the marks-not-sent check. bench_event already has an index
--                                   on (session_id); this one carries `kind` so the count does
--                                   not read every event of the session.
--
-- The four warehouse type names are WAREHOUSE_CUE_TYPES in lib/mcp/tools/fuse-report.ts, and
-- 'consult_mark' is MARK_CUE_TYPE beside it. Spelled out here because an index predicate cannot
-- interpolate a TypeScript constant; the monitor's queries repeat them from those constants, and
-- a test reads this file to hold the two in agreement.
--
-- NOT TOUCHED: cue_room_day_at_idx (0042), the natural keys of 0046/0047/0050–0052, and every
-- table. This migration creates four indexes and its own schema_migrations row, and does nothing
-- else.
-- =====================================================================

CREATE INDEX IF NOT EXISTS bench_session_room_started_idx
  ON bench_session (room_id, started_at DESC);

CREATE INDEX IF NOT EXISTS cue_warehouse_recent_idx
  ON cue (room_day_id, at DESC)
  WHERE type IN ('pqm_called', 'pstart', 'dx_event', 'pulse_note');

CREATE INDEX IF NOT EXISTS cue_mark_recent_idx
  ON cue (room_day_id, at DESC)
  WHERE type = 'consult_mark';

CREATE INDEX IF NOT EXISTS bench_event_session_kind_idx
  ON bench_event (session_id, kind);

INSERT INTO schema_migrations (version, name)
VALUES (54, '0054_live_monitor_indexes')
ON CONFLICT DO NOTHING;
