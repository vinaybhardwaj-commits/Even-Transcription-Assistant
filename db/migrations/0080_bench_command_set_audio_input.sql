-- =====================================================================
-- Migration 0080 — Release R4, server half: a fifth command kind, and the two volume facts a room
-- reports about the input it records from.
--
-- WHY (Install and Fleet PRD, Release R4 addendum of 11 September 2026, decisions R4-D1 and R4-D4).
-- OPD 3 and OPD 7 record bit-exact silence from a TONOR TM20 while a working C270 sits attached in
-- each room, and nobody can enter either room. R4 makes "switch the input to the C270" a command from
-- the desk, on the bench bus that already carries start/pause/resume/end.
--
-- THE KIND CHECK IS SWAPPED, NOT WIDENED IN PLACE (R4-D1). 0044 wrote the CHECK inline on the column,
-- so Postgres named it; this migration does NOT type that name. The DO block reads it out of
-- pg_constraint — the one CHECK on bench_command whose columns are exactly `kind` — drops it by what
-- the catalogue says, and adds the five-value CHECK under the explicit name bench_command_kind_check.
-- More than one CHECK on `kind` means someone has been here by hand, and the block refuses rather
-- than choose one. The drop and the add are ONE statement (the DO block), and the runner wraps the
-- whole file in one transaction as well, so there is no instant at which bench_command admits any
-- kind at all. Every existing row holds one of the first four kinds, so the new CHECK validates by a
-- scan of a small table under the ALTER's lock.
--
-- `input_volume` IS MEASURED OR ABSENT (R4-D4). 0..1, CoreAudio's VolumeScalar on the input scope of
-- the device the app records from, `real` like peak and zero_ratio. NULL = not reported — every app
-- below 0.1.21, and a device with no volume control. Out-of-range values are dropped at intake by the
-- same rule as peak, never clamped.
--
-- `input_volume_settable` IS THE ANSWER TO THE 9 SEPTEMBER QUESTION (R4-D4). The TM20 has a physical
-- gain knob and macOS may not expose gain at all. The app reads whether the property is settable and
-- says so on every poll; the fleet card greys the volume slider unless this is TRUE. FALSE is a
-- measurement ("this device has no settable volume"); NULL is "not reported".
--
-- ADDITIVE for room_install: two nullable columns, no DEFAULT, so no row is rewritten.
-- IDEMPOTENT. A re-run finds bench_command_kind_check, drops it and adds the same CHECK back; the
-- columns are ADD COLUMN IF NOT EXISTS.
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
    RAISE EXCEPTION '0080: % CHECK constraints on bench_command.kind; expected exactly one', n_checks;
  END IF;

  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bench_command DROP CONSTRAINT %I', old_name);
  END IF;

  ALTER TABLE bench_command
    ADD CONSTRAINT bench_command_kind_check
    CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input'));
END
$$;

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS input_volume          real NULL,
  ADD COLUMN IF NOT EXISTS input_volume_settable boolean NULL;

COMMENT ON COLUMN room_install.input_volume IS
  'Input volume, 0..1, of the device the app records from: kAudioDevicePropertyVolumeScalar, input scope, master element or channel 1 (R4-D4). MEASURED: omitted when not read, so NULL means not reported. Out-of-range values are dropped at intake, never clamped. COALESCEd on poll.';

COMMENT ON COLUMN room_install.input_volume_settable IS
  'Whether that device''s input volume can be set from software (R4-D4). FALSE is a measurement — the fleet card greys its slider and a set_audio_input carrying input_volume fails volume_not_settable. NULL means not reported (every app below 0.1.21). COALESCEd on poll.';

INSERT INTO schema_migrations (version, name)
VALUES (80, '0080_bench_command_set_audio_input')
ON CONFLICT DO NOTHING;
