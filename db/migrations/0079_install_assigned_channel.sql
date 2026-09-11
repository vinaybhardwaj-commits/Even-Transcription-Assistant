-- =====================================================================
-- Migration 0079 — Release B2, server half: a channel the SERVER may assign, and three new
-- measurements a room reports about its own input.
--
-- WHY (Install and Fleet PRD, Release B2 addendum of 11 September 2026, decisions D5, D7, D10).
--
-- `assigned_channel` IS ONE-WAY, AND THE CHECK IS HOW (B2-D5). Today a Mac's channel is whatever its
-- own config.json says, and the only way to move Room 4.1 back from `test` is a hand on that Mac.
-- B2 lets an admin say "move to stable" from the fleet card; the poll response carries the value and
-- the 0.1.20 app applies it only when it is `stable` and its own channel is not. The server may
-- never put a Mac on `test` — that stays a hand on the Mac (R3-8's valve, per Mac) — so the column
-- admits exactly one value, and a second value is a migration, not a typo. NULL means "nothing
-- assigned": the Mac's own config.json decides, exactly as it does today.
--
-- `peak` AND `zero_ratio` ARE MEASURED OR ABSENT (B2-D7). OPD 3 recorded a morning at 45.76 % bit-exact
-- zero and nobody could see it; RMS alone hides both clipping and a dead input. Both are 0..1 over the
-- app's last piece window, `real` because they are ratios read by eye, not sums. NULL = not reported.
--
-- `input_devices` IS THE WHOLE LIST, READ-ONLY (B2-D10). `input_device_name` (0077) says which input
-- the room records from; this says what else is plugged in, with the system default marked. OPD 7 has
-- a TONOR and a C270 and nobody can see which is live without SSH. A JSON array of
-- {name, uid, is_default}, bounded by `cleanPollFields` before it is ever written. NULL = never
-- reported; no control writes it — R4 owns setting the device.
--
-- ADDITIVE. Four nullable columns, no DEFAULT, so no row is rewritten. The CHECK on a column that is
-- NULL in every existing row validates by a scan of a table of a few dozen rows, under the
-- ALTER's lock, inside one transaction.
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS throughout, so a re-run does nothing.
-- =====================================================================

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS assigned_channel text NULL CHECK (assigned_channel IN ('stable')),
  ADD COLUMN IF NOT EXISTS peak             real,
  ADD COLUMN IF NOT EXISTS zero_ratio       real,
  ADD COLUMN IF NOT EXISTS input_devices    jsonb;

COMMENT ON COLUMN room_install.assigned_channel IS
  'The channel an admin assigned from the fleet card (B2-D5). ONE-WAY: the CHECK admits only stable, because the server may move a Mac off test but never onto it — that stays a hand on the Mac (R3-8). Carried in the poll response; the app (0.1.20 and later) applies it only when it is stable and its own channel is not. NULL means nothing assigned and the Mac''s own config.json decides.';

COMMENT ON COLUMN room_install.peak IS
  'Highest absolute sample, 0..1, over the app''s last piece window (B2-D7). MEASURED per §5.5: omitted when not read, so NULL means not reported, never silence. COALESCEd on poll.';

COMMENT ON COLUMN room_install.zero_ratio IS
  'Fraction of samples that were bit-exact zero, 0..1, over the same window as peak (B2-D7). OPD 3 read 0.4576 on 9 September and nobody could see it. NULL means not reported. COALESCEd on poll.';

COMMENT ON COLUMN room_install.input_devices IS
  'Every input device CoreAudio listed at the moment of the poll, as a JSON array of {name, uid, is_default} (B2-D10), bounded by cleanPollFields (at most 16 entries, at most one default). READ-ONLY: no control writes it. NULL means never reported. COALESCEd on poll, so a poll that omits it keeps the last list.';

INSERT INTO schema_migrations (version, name)
VALUES (79, '0079_install_assigned_channel')
ON CONFLICT DO NOTHING;
