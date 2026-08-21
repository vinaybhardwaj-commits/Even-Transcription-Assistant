-- =====================================================================
-- Migration 0048 — the visit's arm (ETA Fuse slice 4, 21 Aug 2026).
-- Additive + idempotent. Same shape as 0046/0047: columns, one partial
-- unique index, and the file records itself.
--
-- Slice 4 runs THREE algorithms over the same scratch cue graph — 'rules',
-- 'hybrid', 'flash' — and each writes its own visit rows so the designer can
-- score them side by side. Nothing has ever written a visit row before today,
-- so every column below starts empty on every existing row (there are none).
--
--   visit.arm            — which algorithm wrote this row. NULLABLE, and NO
--                          CHECK: kept open exactly as cue.type and cue.source
--                          are, because a fourth arm is a data change, not a
--                          migration. Readers coalesce NULL to 'rules' so a
--                          future writer that sets no arm still reads rather
--                          than vanishing.
--
--   visit.opened_by      — the OPENING EVIDENCE: the source_ref of the pstart
--                          (or pqm_called) that opened the visit, or the cue id
--                          of the consult_mark when there is no warehouse
--                          opener at all. NULLABLE.
--
--   visit.opened_by_kind — 'pstart' | 'pqm_called' | 'mark'. Reporting only,
--                          nullable, no CHECK.
--
-- THE KEY IS PER ARM + OPENING EVIDENCE, NEVER PER PERSON. This is the whole
-- point of the index below and it is worth stating why the obvious key is wrong:
--
--   * (arm, room_day_id, individual_uid) would FORBID §10.3 — a second pstart
--     with a different calendar_uid is a second visit for the same person on the
--     same day, and that row is one of the ten being scored.
--   * it also cannot hold a mark-only visit, whose individual_uid is NULL,
--     because NULLs do not collide in a unique index and every such visit would
--     be written again on every re-run.
--
-- PARTIAL, WHERE both columns are NOT NULL, for the same reason 0046's and
-- 0047's indexes are partial: rows that carry neither value must not enter the
-- index at all, so they can never collide with each other.
--
-- NOT TOUCHED, deliberately: visit.state's CHECK
-- ('called','in_chair','at_diagnostics','ended','unknown'), visit_room_day_idx,
-- and every index and column on cue, room_day and speaker_cluster.
-- speaker_cluster.visit_id stays single-valued and nothing in this slice
-- attaches a cluster (X5).
--
-- ADD COLUMN IF NOT EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS are idempotent
-- by name, so no DO $$ … EXCEPTION $$ wrapper is needed here.
-- =====================================================================

-- 1. Which arm wrote the row. NULL reads as 'rules' (see SQL_VISITS_FOR_DAY).
ALTER TABLE visit
  ADD COLUMN IF NOT EXISTS arm text;

-- 2. The opening evidence, and what kind of evidence it was.
ALTER TABLE visit
  ADD COLUMN IF NOT EXISTS opened_by text;

ALTER TABLE visit
  ADD COLUMN IF NOT EXISTS opened_by_kind text;

-- 3. One visit per (arm, opening evidence). Re-running an arm writes nothing
--    that already exists: the fuse insert takes ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS visit_arm_opened_by_key
  ON visit (arm, opened_by)
  WHERE arm IS NOT NULL AND opened_by IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (48, '0048_visit_arm')
ON CONFLICT DO NOTHING;
