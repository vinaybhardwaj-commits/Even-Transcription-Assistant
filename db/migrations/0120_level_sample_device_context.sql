-- =====================================================================
-- Migration 0120 — bench_level_sample: the input context each level sample was taken in (Fable ruling 346, 25 Sep 2026).
--
-- WHY. The level log answers "how loud was the room". It could not answer the question OPD 4 asked on 25 Sep: WHICH input, in which
-- mic state, at which volume, on which app version, was the Mac using when a stretch went near-silent. The fleet row (room_install)
-- holds only the LATEST value of each (its columns COALESCE), and its 10-poll ring carries no device name at all, so the history of
-- the 11-14 Sep episode could not be rebuilt and the 23-24 Sep one still cannot be attributed to a device. These four columns
-- carry, on every native poll's level row, what THAT poll reported.
--
-- ADDITIVE, NULLABLE, NO BACKFILL, NO DEFAULT. A row written before this migration, a browser kiosk row and a poll that omits a field
-- all read NULL = "not reported", never a guessed value. The values are the CLEANED install fields (cleanPollFields bounds each:
-- 32-char mic state, a 0..1 volume, a bounded device name, a bounded app version), so nothing new can reach the table unbounded.
-- DEVICE NAMES CAN CARRY A PERSON'S NAME (eta-refuter #2016): macOS names Continuity and Bluetooth inputs after their owner
-- ("<Name>'s iPhone Microphone", "<Name>'s AirPods"). The code therefore drops everything up to and including a leading possessive
-- ('s or a typographic ’s) before the name is stored (levelDeviceName, lib/bench-levels.ts). RESIDUAL RISK: a device its owner renamed
-- to their own name WITHOUT a possessive is not caught; room_install.input_device_name already keeps the latest name unstripped.
--
-- APPLY ORDER: migrate BEFORE deploying the code that writes these columns. The level insert is best-effort (a failure logs and the
-- command poll carries on), so the code deployed first would not break a room, but it would lose every level sample until the
-- migration ran, because the INSERT names the columns. NOTE: POST /api/run-migrations reads db/migrations from the DEPLOYED build, so
-- it cannot apply this before the deploy that carries the file; applying it first means running this SQL directly against the app
-- database (safe to run twice), which also records the schema_migrations row so the endpoint later sees it as applied.
--
-- Mark, never delete: nothing here removes or rewrites an existing row. Retention is unchanged (7 IST days).
-- =====================================================================
ALTER TABLE bench_level_sample
  ADD COLUMN IF NOT EXISTS mic_state         text,
  ADD COLUMN IF NOT EXISTS input_volume      real,
  ADD COLUMN IF NOT EXISTS input_device_name text,
  ADD COLUMN IF NOT EXISTS app_version       text;

INSERT INTO schema_migrations (version, name) VALUES (120, '0120_level_sample_device_context')
ON CONFLICT (version) DO NOTHING;
