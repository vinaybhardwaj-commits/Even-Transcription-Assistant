-- =====================================================================
-- Migration 0092 — S1 FIX2 (C6): the auto-drain's refusals become data on the window.
--
-- WHY. The auto-drain (lib/stt/auto-drain.ts) offers one window per tick. A refusal that returns
-- before the drain's claim — flag_off, too_long, join_failed (lib/stt/room-drain.ts) — leaves the
-- window `closed`, so the same window was picked again on every tick. One recording room with its
-- Transcript switch off held the only slot and starved every other room.
--
-- So a refusal is recorded, and it cools the window down:
--   auto_drain_refused_at      when the auto-drain last offered this window and the drain refused it
--   auto_drain_refused_reason  the drain's step name for that refusal (e.g. 'flag_off')
-- The auto-drain sets both on any step other than `enqueued`, clears both on a successful enqueue,
-- and skips a window refused within AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES. A window whose room is
-- switched on is picked up within the cooldown; a permanently broken one costs one slot per cooldown
-- instead of every tick, and the reason can be queried.
--
-- The only writer of these two columns is lib/stt/auto-drain.ts.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS. Both nullable with no default, so existing rows are
-- untouched and no table rewrite is needed.
--
-- GRANTS: none. bench_window is app-owned (0057).
-- =====================================================================

ALTER TABLE bench_window ADD COLUMN IF NOT EXISTS auto_drain_refused_at timestamptz NULL;
ALTER TABLE bench_window ADD COLUMN IF NOT EXISTS auto_drain_refused_reason text NULL;

INSERT INTO schema_migrations (version, name)
VALUES (92, '0092_bench_window_auto_drain_refusal')
ON CONFLICT DO NOTHING;
