-- =====================================================================
-- Migration 0067 — repair the stored end times that do not match their tape.
--
-- WHY (PRD §3.3, Build 2 §2.5). A session's stored `ended_at` was written as `NOW()` at the moment
-- the PATCH arrived, which is not the moment the recording stopped. `bs_f46u4jxw` on OPD 5 carries
-- a stored end more than ten minutes after its last piece; `bs_jmh9jxmx` carries a stale one left
-- by an earlier version of the disagreement alarm. 0066's companion code change fixes the two
-- write paths so no new row is created wrong. This repairs the rows already wrong.
--
-- THIS IS THE ONLY STATEMENT IN BUILD 2 THAT REWRITES EXISTING DATA, and it is fenced accordingly.
--
-- WHAT IT TOUCHES: `bench_session.ended_at`, on ended sessions only, and only where the stored end
-- is MORE THAN TEN MINUTES LATER than the newest verified piece on that session. Ten minutes is
-- the stall window the operator page already uses to call an end time a lie — the same number, so
-- this repairs exactly the rows that surface as wrong on the screen and nothing else.
--
-- WHAT IT WILL NOT TOUCH, and each exclusion is deliberate:
--
--   * A session with NO verified pieces. There is no tape to take an end from, so there is
--     nothing better to write than what is there. The join below drops these rows.
--   * A session whose stored end is EARLIER than its last piece. That is the ended-disagrees
--     shape — audio recorded after the row said stop — and it is a real fault to investigate,
--     not a clock error to tidy away. Moving the end forwards would erase the evidence.
--   * A session within ten minutes of its tape. Ordinary: the kiosk PATCHes end as the recorder
--     stops and the flush piece lands a moment later.
--   * `status`. No session is opened, closed or reclassified. Only a timestamp moves, and only
--     ever BACKWARDS, onto an instant at which audio provably existed.
--   * `bench_chunk`. Not named in this migration. No audio is read, moved, rewritten or deleted,
--     and there is no statement here that could.
--
-- IDEMPOTENT. After it runs, every row it touched has `ended_at` equal to its last verified piece,
-- so the `> 10 minutes` predicate is false for all of them and a second run updates nothing. It is
-- also idempotent against the code change: new rows are already written this way.
--
-- REVERSIBLE ONLY FROM A BACKUP, which is why the SELECT that lists the affected rows is included
-- above the UPDATE as a comment. Run it first if you want the before-and-after; it is the same
-- predicate, so what it lists is exactly what changes.
--
--   SELECT s.id, s.room_id, s.ended_at AS stored_end,
--          MAX(c.ended_at) AS last_verified_piece,
--          s.ended_at - MAX(c.ended_at) AS overstated_by
--     FROM bench_session s
--     JOIN bench_chunk c ON c.session_id = s.id AND c.upload_state = 'verified'
--    WHERE s.status = 'ended' AND s.ended_at IS NOT NULL
--    GROUP BY s.id, s.room_id, s.ended_at
--   HAVING s.ended_at > MAX(c.ended_at) + INTERVAL '10 minutes'
--    ORDER BY overstated_by DESC;
--
-- GRANTS: none, and none is needed. bench_session is app-owned and this migration runs as the
-- owner. brain_svc has never held UPDATE on it and does not gain it here.
-- =====================================================================

UPDATE bench_session s
   SET ended_at = t.last_piece
  FROM (
         SELECT c.session_id, MAX(c.ended_at) AS last_piece
           FROM bench_chunk c
          WHERE c.upload_state = 'verified'
          GROUP BY c.session_id
       ) t
 WHERE t.session_id = s.id
   AND s.status = 'ended'
   AND s.ended_at IS NOT NULL
   -- Later than the tape by more than the stall window. An end EARLIER than the tape is the
   -- ended-disagrees fault and is deliberately left alone.
   AND s.ended_at > t.last_piece + INTERVAL '10 minutes';

INSERT INTO schema_migrations (version, name)
VALUES (67, '0067_repair_end_times')
ON CONFLICT DO NOTHING;
