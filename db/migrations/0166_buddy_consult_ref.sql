-- =====================================================================
-- Migration 0166 (PLACEHOLDER NUMBER; gating-lead assigns the real one) — Encounter Buddy L1 ingest relay.
--
-- WHY. The presence ingest relays encounter_open / encounter_close to the room recorder as two new
-- bench command kinds, `consult_started` and `consult_ended`. The recorder only ever sees an opaque
-- id. This table maps opaque_id -> consult_uid (and room, opened_at, closed_at) so the server side
-- can resolve it later. consult_uid, doctor_uid and prescription ids never leave the server.
--
-- ONE CHECK, SWAPPED — 0121's method. The one CHECK on bench_command.kind is read out of
-- pg_constraint by column, dropped by the name the catalogue gives, and added back with the two
-- new kinds appended. More than one CHECK on the column: the block refuses rather than choose.
--
-- IDEMPOTENT. CREATE TABLE IF NOT EXISTS; the DO block drops its own CHECK on a re-run and adds
-- the same one back.
-- =====================================================================

CREATE TABLE IF NOT EXISTS buddy_consult_ref (
  opaque_id   text        PRIMARY KEY,
  consult_uid text        NOT NULL UNIQUE,
  room_id     text        NOT NULL,
  doctor_uid  text,
  opened_at   timestamptz NOT NULL,
  closed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

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
    RAISE EXCEPTION '0166: % CHECK constraints on bench_command.kind; expected exactly one', n_checks;
  END IF;

  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bench_command DROP CONSTRAINT %I', old_name);
  END IF;

  ALTER TABLE bench_command
    ADD CONSTRAINT bench_command_kind_check
    CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input',
                    'check_update_now','report_diag','restart_engine','self_test',
                    'consult_started','consult_ended'));
END
$$;

INSERT INTO schema_migrations (version, name) VALUES (166, '0166_buddy_consult_ref')
ON CONFLICT (version) DO NOTHING;
