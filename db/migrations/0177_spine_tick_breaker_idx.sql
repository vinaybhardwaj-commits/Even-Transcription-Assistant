-- =====================================================================
-- Migration 0177 — Spine: an index for the breaker read on spine_tick (prelive D, S5 R2 N2).
--
-- WHY. openBreakers reads `kind = 'attempt:<stage>'` rows newest first, per stage per claim. spine_tick is only indexed on ticked_at, and nothing prunes it, so the read grows with the table (9.8 ms per stage at 300k rows).
--      lib/spine/jobs.ts now bounds the read to the breaker window (a failure newer than 30 min) and, when one exists, takes the last 20 outcomes of the kind. Both are served by (kind, ticked_at DESC, id DESC).
-- WHAT. One CREATE INDEX IF NOT EXISTS. No data change, no seed, no other schema change. No retention prune (a proposal only; not in this migration).
-- IDEMPOTENT. Safe to run twice. The code works without the index (it falls back to spine_tick_at_idx); the index only makes it cheaper as the table grows.
-- UNDO. db/rollbacks/0177_spine_tick_breaker_idx.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS spine_tick_kind_at_idx ON spine_tick (kind, ticked_at DESC, id DESC);

INSERT INTO schema_migrations (version, name)
VALUES (177, '0177_spine_tick_breaker_idx')
ON CONFLICT DO NOTHING;

COMMIT;
