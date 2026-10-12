-- =====================================================================
-- Migration 0160 — TS-H6 follow-up C1: kiosk_health_dedupe keys a REPLAY on (machine, source, boot_id, seq), not on ts.
--
-- WHY. 0154 recorded a skipped event by (machine, kind, source, ts) and recognised a replay by that same identity, so a NEW event that merely shares a ts with an absorbed one
-- (same Mac, kind and source, a different boot_id/seq) was taken for a replay and dropped: a distinct event lost (refuter probe R8). Every posted event carries boot_id and seq
-- (the envelope requires both), so the replay identity is now (machine, source, boot_id, seq); ts is the identity only for the OLD rows written before this migration, which have
-- no boot_id/seq (boot_id IS NULL), and for an event that carries neither.
--
-- CHANGES (one transaction, idempotent on a re-run):
--   1. kiosk_health_dedupe gains boot_id text and seq BIGINT (the envelope accepts a seq up to 2^53 and kiosk_health_events.seq is bigint), both NULLable (old rows keep NULL).
--   2. The 0154 unique index (machine, kind, source, ts) is DROPPED and re-created as a PARTIAL unique index WHERE boot_id IS NULL, so it still protects every old row and any
--      id-less insert; left as it was, it would make the second event with a shared ts fail to record (ON CONFLICT DO NOTHING) and its own replay unrecognisable.
--   3. A new partial unique index on (machine, source, boot_id, seq) WHERE boot_id IS NOT NULL: a replayed skipped event is recorded once.
-- No data is deleted or rewritten. GRANTS: none (app-owned like 0154). NO PHI: machine names, kinds, boot ids and counters only.
-- DEPLOY ORDER: apply this BEFORE the app. New code on the old schema fails its dedupe lookup, which stores everything (a duplicate beats a lost event) until the migration is applied.
-- =====================================================================
BEGIN;

ALTER TABLE kiosk_health_dedupe ADD COLUMN IF NOT EXISTS boot_id text;
ALTER TABLE kiosk_health_dedupe ADD COLUMN IF NOT EXISTS seq bigint;

DROP INDEX IF EXISTS kiosk_health_dedupe_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS kiosk_health_dedupe_uidx_legacy ON kiosk_health_dedupe (machine, kind, source, ts) WHERE boot_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kiosk_health_dedupe_uidx_id ON kiosk_health_dedupe (machine, source, boot_id, seq) WHERE boot_id IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (160, '0160_kiosk_health_dedupe_boot_seq')
ON CONFLICT DO NOTHING;

COMMIT;
