-- =====================================================================
-- Migration 0121 — Recorder 0.1.25 (W34.1): the ninth bench command kind, `self_test`.
--
-- WHY. The acoustic SELF-TEST (Fable's W34 order) plays a pinned stimulus pack through a room's
-- built-in speaker and records it through the configured mic into a segment separate from any
-- patient session (RoomEngine.startSelfTest, apps/room-recorder). It is a Tier 1 operator verb like
-- `check_update_now` / `report_diag` / `restart_engine`: never journaled, decided and acked once, the
-- native app's alone (a browser kiosk ignores it, R4-D7).
--
-- ONE CHECK, SWAPPED — 0080/0081's method, for 0081's reason. This file reads the one CHECK on
-- bench_command.kind out of pg_constraint by column, drops it by the name the catalogue gives, and
-- adds the same list back with `self_test` appended. More than one CHECK on the column means someone
-- has been here by hand outside a migration, and the block refuses rather than choose.
--
-- NO NEW COLUMN. `self_test`'s args ({volume?: 0.2..0.8}) and its ack ({ok, error?}, no extra
-- fields yet) both fit the existing `bench_command.args` / `bench_command.result` jsonb columns —
-- see lib/bench-commands.ts's `VERB_ARGS.self_test` and `TIER1_VERBS`.
--
-- IDEMPOTENT. The DO block finds its own named CHECK on a re-run, drops it and adds the same one
-- back with `self_test` already present.
-- =====================================================================

DO $$
DECLARE
  n_checks integer;
  old_name text;
BEGIN
  SELECT count(*), min(con.conname::text)
    INTO n_checks, old_name
    FROM pg_constraint con
   WHERE con.conrelid = 'bench_command'::regclass
     AND con.contype = 'c'
     AND con.conkey = ARRAY[(
           SELECT att.attnum
             FROM pg_attribute att
            WHERE att.attrelid = 'bench_command'::regclass
              AND att.attname = 'kind'
         )]::smallint[];

  IF n_checks > 1 THEN
    RAISE EXCEPTION '0121: % CHECK constraints on bench_command.kind; expected exactly one', n_checks;
  END IF;

  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bench_command DROP CONSTRAINT %I', old_name);
  END IF;

  ALTER TABLE bench_command
    ADD CONSTRAINT bench_command_kind_check
    CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input',
                    'check_update_now','report_diag','restart_engine','self_test'));
END
$$;
