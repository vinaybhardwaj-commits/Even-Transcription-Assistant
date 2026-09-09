-- =====================================================================
-- Migration 0078 — what a room says about updating itself.
--
-- WHY (Install and Fleet PRD §13.4, Build R3 addendum of 8 September 2026, plus V's scope
-- addition of 9 September). Build R3 lets a room ask what version it should be running and swap
-- itself to it. Seven facts have to come back off the Mac for that to be observable from the fleet
-- card, and none of them has anywhere to live today.
--
-- `session_open` IS THE ONE THAT FIXES A BUG, not the one that adds a feature. `deriveRow` raises
-- "Tape not advancing" for any reachable install whose `tape_advancing` is false, with no test for
-- whether a session is open at all. Home Office wears that warning right now while it is perfectly
-- healthy, and R3 restarts the app on every update — the first poll after a restart always reports
-- false — so without this column R3 would raise a false warning in every room on every update
-- (R3-3). It is the only column here that a later poll must be able to set back to false, which is
-- why `applyInstallPoll` COALESCEs the other six and deliberately does not COALESCE this one.
--
-- `update_channel` IS THE VALVE (R3-8). R3's whole risk is that one bad publish walks into every
-- room at once. Home Office sits on `test`, clinic rooms sit on `stable`, and the app reports which
-- from its own config.json. NOT NULL DEFAULT 'stable' is the one typed value in this migration and
-- it is ratified rather than assumed: every install that exists today is on stable, and a NULL here
-- would make the card unable to say what a room would download.
--
-- THE FOUR `last_update_*` COLUMNS ARE A RECEIPT, not a status. The swap script writes
-- `<root>/update-result.json`, the new copy of the app reads it on its first start, reports it, and
-- deletes the file. That poll is the only proof an update landed or failed, because the app that
-- attempted it is gone by then. They COALESCE so a later poll cannot erase the record of a failure
-- (R3-7) — the row must keep saying why until a successful update overwrites it.
--
-- `last_update_version` (V, 9 September, Fix 1) IS THE VERSION THE ATTEMPT WAS REACHING FOR. The
-- fleet card's sentence names it — "Update to 0.1.8 stopped at 09:14" — and the first cut of this
-- build had no column for it, so the app packed it into the head of `last_update_error` and the card
-- parsed it back out. That made a free-text column load-bearing and a hand-edit able to break the
-- sentence. It is its own column now.
--
-- `disk_free_bytes` (V, 9 September) IS MEASURED OR ABSENT. Nothing enforces retention today at
-- about 115 MB per recorded hour, so free space on the captures volume is the one machine fact
-- worth having before that lands. The app sends it only when it can read it and NEVER sends 0 or
-- -1 — §5.5 forbids a constant standing in for a measurement, and "0 bytes free" is a clinical
-- emergency this column must never be able to invent. bigint because a byte count on a 2 TB volume
-- does not fit in an int.
--
-- ADDITIVE. Seven nullable-or-defaulted columns. No row is rewritten, no constraint is added, nothing
-- is dropped, and no existing column changes type.
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS throughout, so a re-run does nothing.
--
-- NOT YET APPLIED ANYWHERE at the time this file was written, and neither is 0075, 0076 or 0077
-- confirmed applied in production. This migration is written to be safe whatever the applied state
-- turns out to be.
-- =====================================================================

ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS session_open       boolean,
  ADD COLUMN IF NOT EXISTS update_channel     text NOT NULL DEFAULT 'stable',
  ADD COLUMN IF NOT EXISTS last_update_result text,
  ADD COLUMN IF NOT EXISTS last_update_version text,
  ADD COLUMN IF NOT EXISTS last_update_error  text,
  ADD COLUMN IF NOT EXISTS last_update_at     timestamptz,
  ADD COLUMN IF NOT EXISTS disk_free_bytes    bigint;

COMMENT ON COLUMN room_install.session_open IS
  'Whether a recording session was open on this Mac at the moment of the poll, derived from the app''s own engine (R3-6). NOT the bench listener''s `recording` flag, which has read true on OPD 5 since 24 August with no session open. A LIVE READING, and the one poll column applyInstallPoll must not COALESCE: it has to be able to go false. NULL means never reported, which is what every install below 0.1.8 reports for ever.';

COMMENT ON COLUMN room_install.update_channel IS
  'Which release channel this Mac asks for, as its own config.json states it (R3-8). One of stable or test. Home Office sits on test so a bad publish reaches one Mac and not five. Reported by the app, never typed on the card. NOT NULL DEFAULT ''stable'' because every install predating Build R3 is on stable by construction.';

COMMENT ON COLUMN room_install.last_update_result IS
  'Outcome of the last self-update this Mac attempted, from update-result.json: ok, checksum_mismatch, signature_mismatch, download_failed, expand_failed or swap_failed. COALESCEd on poll so a later poll cannot erase the record of a failure (R3-7). NULL means no update has ever been attempted on this Mac.';

COMMENT ON COLUMN room_install.last_update_version IS
  'The version the last self-update attempt was trying to reach — 0.1.8 in "Update to 0.1.8 stopped at 09:14". A COLUMN OF ITS OWN (V, 9 September 2026, Fix 1) because the card''s sentence names it and the first cut of R3 packed it into the head of last_update_error and parsed it back out, which made a free-text column load-bearing. COALESCEd with the other update columns. NULL means no attempt has been recorded.';

COMMENT ON COLUMN room_install.last_update_error IS
  'What went wrong on the last self-update attempt, in one sentence, as update-result.json recorded it. The VERSION it was reaching for lives in last_update_version, not here — see that column. COALESCEd with last_update_result. NULL when the last attempt succeeded or none has been made.';

COMMENT ON COLUMN room_install.last_update_at IS
  'When the swap script recorded that outcome, as it wrote it into update-result.json. The Mac''s clock, not the server''s — it is the time the attempt ended, and the app that attempted it had already exited. COALESCEd with the other three.';

COMMENT ON COLUMN room_install.disk_free_bytes IS
  'Free space on the volume holding this room''s captures directory, via URLResourceKey.volumeAvailableCapacityForImportantUsageKey, read at the moment of the poll (V, 9 September 2026). MEASURED per §5.5: the app OMITS the field when it cannot read it and never sends 0 or -1, so NULL means "not reported" and never means "full". COALESCEd like the rest.';

INSERT INTO schema_migrations (version, name)
VALUES (78, '0078_install_update_fields')
ON CONFLICT DO NOTHING;
