-- =====================================================================
-- Migration 0081 — Tier 1: named room states, three operator verbs, and a channel the server may
-- set to `test`.
--
-- WHY (ETA Tier 1 spec v1.1, 11 September 2026, §2 and §3). A room recording silence, clipping, on the
-- wrong device, with a stalled encoder or a filling disk should be a NAMED STATE on the server within
-- one poll, from fields the app already sends. And three things that today need a person at the Mac or
-- a six-hour wait become commands on the bench bus: check_update_now, report_diag, restart_engine.
--
-- ONE MIGRATION FOR BOTH SLICES, AND THE ORDER OF THE ROLLOUT IS WHY. Slice A (states) ships first and
-- applies this file; Slice B (verbs, app 0.1.22) ships after it. The runner never re-runs a version it
-- has recorded, so anything Slice B needed that was not already here would never reach a database that
-- took Slice A. Every change below is additive or widens a CHECK, so the Slice B half is inert until
-- the Slice B server writes to it.
--
-- `state_flags` IS WHAT THE SERVER CONCLUDED, `poll_ring` IS WHAT IT SAW (§2). The ring is the last ten
-- polls' raw readings, newest first, written in the poll's own UPDATE. The flags are the named states
-- evaluated from it by `evaluateInstallStates` (lib/bench-bus-constants.ts) and written only when they
-- change. `state_changed_at` moves only when the SET of flags changes. NULL on all three = never
-- evaluated (a row no poll has reached since this migration), never "healthy".
--
-- `expected_device_name` IS THE DEVICE THE ROOM SHOULD BE ON (§2, DEVICE_CHANGED). Set from the device
-- list when a set_audio_input is acked; NULL otherwise, and a poll adopts the name it reports when the
-- column is NULL — which is what "the name at enrol" means for a row that existed before this file.
--
-- `clip_count`, `silence_ms`, `channel_locked` ARE THE 0.1.22 HEARTBEAT (§3). Measured or absent, like
-- every poll field since §5.5: NULL = not reported, which is every app below 0.1.22.
--
-- THE TWO CHECKS ARE SWAPPED, NOT WIDENED IN PLACE — 0080's method, for 0080's reason. 0044 and 0079
-- wrote their CHECKs inline, so Postgres named them (0080 then named the kind CHECK explicitly). Each
-- DO block reads the one CHECK on its column out of pg_constraint, drops it by what the catalogue says,
-- and adds the wider CHECK under an explicit name. More than one CHECK on a column means someone has
-- been here by hand, and the block refuses rather than choose. Each drop-and-add is one statement, and
-- the runner wraps the file in one transaction, so there is no instant at which either column admits
-- anything. Every existing row already satisfies the wider CHECK.
--
-- `assigned_channel` MAY NOW BE `test` (§3, D1 amended). 0079's comment called the column one-way; that
-- ruling is superseded. A 0.1.21 app still applies only `stable` (RoomConfiguration.
-- applyServerAssignedChannel), so a `test` assignment is inert on it; a 0.1.22 app applies either
-- unless its config.json says `channel_locked`.
--
-- ADDITIVE for room_install: seven nullable columns, no DEFAULT, so no row is rewritten.
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS; each DO block finds its own named CHECK on a re-run, drops it
-- and adds the same one back.
-- =====================================================================

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS state_flags          jsonb       NULL,
  ADD COLUMN IF NOT EXISTS state_changed_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS poll_ring            jsonb       NULL,
  ADD COLUMN IF NOT EXISTS expected_device_name text        NULL,
  ADD COLUMN IF NOT EXISTS clip_count           integer     NULL,
  ADD COLUMN IF NOT EXISTS silence_ms           bigint      NULL,
  ADD COLUMN IF NOT EXISTS channel_locked       boolean     NULL;

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
    RAISE EXCEPTION '0081: % CHECK constraints on bench_command.kind; expected exactly one', n_checks;
  END IF;

  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bench_command DROP CONSTRAINT %I', old_name);
  END IF;

  ALTER TABLE bench_command
    ADD CONSTRAINT bench_command_kind_check
    CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input',
                    'check_update_now','report_diag','restart_engine'));
END
$$;

DO $$
DECLARE
  n_checks integer;
  old_name text;
BEGIN
  SELECT count(*), min(con.conname::text)
    INTO n_checks, old_name
    FROM pg_constraint con
   WHERE con.conrelid = 'room_install'::regclass
     AND con.contype = 'c'
     AND con.conkey = ARRAY[(
           SELECT att.attnum
             FROM pg_attribute att
            WHERE att.attrelid = 'room_install'::regclass
              AND att.attname = 'assigned_channel'
         )]::smallint[];

  IF n_checks > 1 THEN
    RAISE EXCEPTION '0081: % CHECK constraints on room_install.assigned_channel; expected exactly one', n_checks;
  END IF;

  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE room_install DROP CONSTRAINT %I', old_name);
  END IF;

  ALTER TABLE room_install
    ADD CONSTRAINT room_install_assigned_channel_check
    CHECK (assigned_channel IN ('stable','test'));
END
$$;

COMMENT ON COLUMN room_install.state_flags IS
  'Tier 1 §2. The named states the server concluded for this install at its latest poll, as {"flags": [...], "drift_since": iso|null}. Evaluated by evaluateInstallStates (lib/bench-bus-constants.ts) from poll_ring and the COALESCEd poll columns, and written only when it changes. NULL means never evaluated, never healthy.';

COMMENT ON COLUMN room_install.state_changed_at IS
  'Tier 1 §2. When the SET of flags in state_flags last changed. NULL until the first change.';

COMMENT ON COLUMN room_install.poll_ring IS
  'Tier 1 §2. The last ten polls, newest first: [{at, peak, zero_ratio, tape_advancing, rec, silent_polls, clip_count?, silence_ms?}]. Appended and capped in the poll''s own UPDATE; silent_polls is the consecutive-silent count carried from the previous head.';

COMMENT ON COLUMN room_install.expected_device_name IS
  'Tier 1 §2, DEVICE_CHANGED. The input the room should be recording from: set from input_devices when a set_audio_input is acked, and adopted from the poll''s input_device_name while NULL (enrol, or a row older than 0081).';

COMMENT ON COLUMN room_install.clip_count IS
  'Tier 1 §3. Full-scale samples counted since the previous poll (app 0.1.22). MEASURED: NULL means not reported. COALESCEd on poll.';

COMMENT ON COLUMN room_install.silence_ms IS
  'Tier 1 §3. Milliseconds since the last sample above -55 dBFS (app 0.1.22). MEASURED: NULL means not reported. COALESCEd on poll.';

COMMENT ON COLUMN room_install.channel_locked IS
  'Tier 1 §3, D1 amended. TRUE when the Mac''s config.json pins its channel and it ignores assigned_channel; the fleet card says so. NULL means not reported (every app below 0.1.22). COALESCEd on poll.';

COMMENT ON COLUMN room_install.assigned_channel IS
  'The channel an admin assigned from the fleet card: stable (B2-D5) or test (Tier 1 §3). Carried in the poll response. A 0.1.21 app applies only stable; 0.1.22 applies either unless channel_locked. Cleared by the poll that reports the assigned channel itself. NULL means nothing assigned and the Mac''s own config.json decides.';

INSERT INTO schema_migrations (version, name)
VALUES (81, '0081_room_states_and_verbs')
ON CONFLICT DO NOTHING;
