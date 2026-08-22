-- =====================================================================
-- Migration 0053 — the brain role's table privileges (speech turns, slice A, K3 follow-up,
-- 22 Aug 2026).
--
-- THE FIRST MIGRATION IN THIS REPO THAT GRANTS ANYTHING, and that is the point.
--
-- WHAT HAPPENED. K3's batch path is the first code in this system to issue DELETE FROM cue;
-- every write before it was INSERT-only. Production logs at 06:06 show two
-- POST /api/brain/cues returning 503 with `permission denied for table cue`. The role
-- authenticated fine and /api/brain/health passed, because SELECT was never the problem — the
-- role simply had no DELETE. Measured, not guessed:
--
--   role      brain_svc (BRAIN_DATABASE_URL), database neondb
--   owner     neondb_owner (APP_DATABASE_URL — the same database; the migration runner
--             connects as the owner, which is why this file can grant at all)
--
--   BEFORE                                    cue  room_day  visit  speaker_cluster  room
--     SELECT                                   y      y        y          y           y
--     INSERT                                   y      y        y          y           .
--     UPDATE                                   y      y        y          y           .
--     DELETE                                   .      .        .          .           .
--
-- The gap is UNIFORM: DELETE was omitted from all four brain-graph tables when the role was
-- created out of band. cue is the one that has bitten; the other three are the same wall a
-- little further along, and the fuse is the obvious next thing to want a replace.
--
-- WHY DELETE ON ALL FOUR AND NOT JUST cue. A role that already holds INSERT and UPDATE on a
-- table can already destroy the contents of any row in it. Withholding DELETE from such a role
-- is not a meaningful boundary — it is a tripwire that fires the first time somebody writes a
-- replace, at 503, in production, an hour before anyone reads the actual message. The real
-- boundary is which TABLES the role may write at all, and that is unchanged here.
--
-- `room` STAYS SELECT-ONLY, deliberately. The brain reads rooms to validate a cue and has never
-- created, changed or removed one — that is the app's table, on the app's path. Widening it
-- would be the only privilege in this file that no code has ever asked for.
--
-- NOTHING IS REVOKED. This migration only adds, so replaying it against a database whose role
-- was already fixed by hand is a no-op, and it can never narrow a privilege something depends on.
--
-- GUARDED ON THE ROLE EXISTING. A GRANT to a missing role is an ERROR, and an erroring migration
-- blocks every migration after it. A fresh database (a developer's branch, a restored copy)
-- legitimately has no brain_svc, so the whole thing is wrapped in a DO block that checks
-- pg_roles first and raises a NOTICE instead. The migration still records itself either way:
-- "this database has been considered" is the fact worth recording, and re-running it after the
-- role is created is one line of SQL, not a schema repair.
--
-- WHY THIS IS A MIGRATION AT ALL. Before today, grants in this system existed only in whatever
-- console session created the role — they were not in the repo, not in review, not in any
-- environment's history, and not reproducible on a new database. The consequence was an hour of
-- diagnosis for a one-word answer. A privilege the code DEPENDS ON is part of the schema, and
-- belongs where the rest of the schema is.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc') THEN
    RAISE NOTICE '0053: role brain_svc does not exist here — nothing granted (this is expected on a database that does not serve the brain)';
    RETURN;
  END IF;

  -- The verb K3 needs, on the table it needs it on.
  GRANT DELETE ON TABLE cue TO brain_svc;

  -- The same gap on the rest of the brain graph, closed now rather than at the next 503.
  GRANT DELETE ON TABLE room_day TO brain_svc;
  GRANT DELETE ON TABLE visit TO brain_svc;
  GRANT DELETE ON TABLE speaker_cluster TO brain_svc;

  -- Belt and braces on the three the role is supposed to already hold everywhere. GRANT is
  -- idempotent, so this costs nothing where they are present and repairs a database where one
  -- of them was missed the same way DELETE was.
  GRANT SELECT, INSERT, UPDATE ON TABLE cue, room_day, visit, speaker_cluster TO brain_svc;
  GRANT SELECT ON TABLE room TO brain_svc;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (53, '0053_brain_role_grants')
ON CONFLICT DO NOTHING;
