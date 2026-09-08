-- =====================================================================
-- Migration 0077 — the eighth poll field: what the room's microphone is CALLED.
--
-- WHY (Install and Fleet PRD §4.3/§5.5, V's ruling of 8 September 2026). The install path had no
-- way to say which input a room records from. `room_install` carried the mic PERMISSION state and
-- nothing about the device, so a room could report `mic_state = authorized` while listening to
-- the wrong microphone, and the fleet card had no way to show it. The app now takes the system
-- default input at enrol, stores its UID in config.json, and reports that device's NAME on every
-- poll. This column is where the name lands, and the card renders it beside the mic state.
--
-- THE NAME, NOT THE UID. The UID is a stable machine-readable string
-- ("AppleUSBAudioEngine:FuZhou Kingwayinfo CO.,LTD:TONOR TM20 Audio Device:20200918:1") and it
-- lives on the Mac, in config.json, because that is what selects the device. What an operator
-- needs on a fleet row is "TONOR TM20 Audio Device". Only the name crosses the wire.
--
-- NULLABLE, WITH NO DEFAULT, and that is the point. §5.5's invariant is that no reported value is
-- a constant standing in for a measurement. The app omits this field when the configured device
-- is not attached, `applyInstallPoll` COALESCEs it like every other poll column, and NULL here
-- means "never reported" rather than "no microphone". A DEFAULT would turn an unmeasured row into
-- a claim.
--
-- ADDITIVE. One nullable column. No row is rewritten, no constraint is added, nothing is dropped.
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, so a re-run does nothing.
-- =====================================================================

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS input_device_name text;

COMMENT ON COLUMN room_install.input_device_name IS
  'Display name of the audio input the room records from, as CoreAudio reported it at the moment of the poll (e.g. "TONOR TM20 Audio Device"). MEASURED per §5.5, never typed. NULL means never reported — the app omits the field when the configured device is not attached, so COALESCE keeps the last true name rather than blanking the row. The selecting UID stays on the Mac in config.json and never crosses the wire.';

INSERT INTO schema_migrations (version, name)
VALUES (77, '0077_install_input_device_name')
ON CONFLICT DO NOTHING;
