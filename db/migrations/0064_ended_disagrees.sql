-- 0064 — one ended_disagrees event per session, not one per chunk.
--
-- WHY THERE IS AN INDEX HERE AT ALL. When a chunk arrives for a session whose status is
-- 'ended', the server stores it exactly as normal (it must — bs_g3dwud4p's 108 such chunks are
-- all present and verified, and refusing would have turned a bookkeeping fault into lost
-- recording) and records ONE bench_event so the disagreement exists in the timeline rather than
-- only in a log. "One" is the whole requirement: a kiosk that has not been told keeps uploading
-- every five minutes for hours, and 108 identical rows is not a timeline.
--
-- The write is an ON CONFLICT DO NOTHING arbitrating on this index, so first-detection is decided
-- by Postgres and not by a read-then-write that two concurrent after() hooks could both pass.
--
-- PARTIAL, on purpose. bench_event.kind is an open set (0043) and every other kind is legitimately
-- many-per-session — consult_mark, the mic story, the handover events. A unique index over
-- (session_id, kind) would break all of them. This one constrains exactly the one kind that must
-- be unique and is invisible to the rest.
CREATE UNIQUE INDEX IF NOT EXISTS bench_event_ended_disagrees_once_idx
  ON bench_event (session_id)
  WHERE kind = 'ended_disagrees';

COMMENT ON INDEX bench_event_ended_disagrees_once_idx IS
  'One ended_disagrees event per session. Arbiter for the chunk route''s ON CONFLICT DO NOTHING: a kiosk that was never told keeps uploading for hours, and the disagreement is one fact, not one per chunk.';

INSERT INTO schema_migrations (version, name)
VALUES (64, '0064_ended_disagrees')
ON CONFLICT DO NOTHING;
