-- =====================================================================
-- Migration 0100 — E22 R11: index the auto-drain's refusal branch.
--
-- WHY. Since E22 R3 (lib/stt/auto-drain.ts), "last served" per room is the newest OFFER inside
-- AUTO_DRAIN_MAX_AGE_HOURS: a room_window job, or a window's auto_drain_refused_at. The refusal half
-- of that CTE reads
--     SELECT … FROM bench_window rw JOIN bench_session rs ON rs.id = rw.session_id
--      WHERE rw.auto_drain_refused_at >= NOW() - (<hours> * INTERVAL '1 hour')
-- on every cron tick (every 5 minutes, 288 times a day). 0092 added the column with no index, so that
-- predicate scans the whole of bench_window, and bench_window only grows.
--
-- SCOPE. Partial, on exactly the rows the branch can select: a `>=` comparison is never true for NULL,
-- so the planner proves `auto_drain_refused_at IS NOT NULL` from the branch's own predicate and may use
-- this index. Most windows are never refused (the column is NULL on them), so the index stays small.
--
-- NOT CONCURRENTLY. app/api/run-migrations applies each file inside sql.transaction([...]), and
-- CREATE INDEX CONCURRENTLY cannot run in a transaction. A plain CREATE INDEX takes a SHARE lock on
-- bench_window for the length of the build (window closes and state updates wait on it); the build
-- reads every row once to find the few non-null ones.
--
-- OWED AT APPLY TIME (E22 R22). The before/after plans on the commit that added this file are from a local
-- postgres:16 on synthetic rows. The LIVE post-apply plan could not be taken before the index existed. Whoever
-- applies this runs, read-only, and records in the apply record:
--     EXPLAIN (ANALYZE, BUFFERS)
--     SELECT rs.room_id, rw.auto_drain_refused_at AS offered_at
--       FROM bench_window rw JOIN bench_session rs ON rs.id = rw.session_id
--      WHERE rw.auto_drain_refused_at >= NOW() - (6::int * INTERVAL '1 hour');
--     SELECT count(*) FROM bench_window;
-- The measurement is owed; it is not optional, and it is not this migration's commit to make.
--
-- IDEMPOTENT: IF NOT EXISTS.
-- GRANTS: none. bench_window is app-owned (0057).
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_bench_window_auto_drain_refused_at
  ON bench_window (auto_drain_refused_at)
  WHERE auto_drain_refused_at IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (100, '0100_bench_window_auto_drain_refused_idx')
ON CONFLICT DO NOTHING;
