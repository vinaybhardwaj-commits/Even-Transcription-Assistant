-- =====================================================================
-- Migration 0083 — Tier 2 Slice C1, step 1: the missing (room, 'default') routing row.
--
-- THIS IS A SAFETY NET, AND IT IS DELIBERATELY FIRST. It changes no behaviour today; it exists so
-- that everything after it is reversible without an outage.
--
-- WHAT IS WRONG TODAY. `stt_routing` holds six rows — live/note/room x english/indic — and NO
-- 'default' row for the room stage. `resolveRouting` (lib/stt/routing.ts:15-31) looks up
-- (stage, bucket); if that row is missing or its engine_id is the literal 'auto', it falls back to
-- (stage, 'default'); if THAT is missing or 'auto' it returns null. The room caller treats null as
-- a hard stop: `recordFailure(windowId, "no_engine", ...)` (lib/stt/room-drain.ts:488-492).
--
-- So with no (room,'default') row, the two room rows are a single point of failure. Deleting either
-- one, or setting it to 'auto' — the two most natural things an operator does when rolling a change
-- back from the STT lab UI — fails EVERY room window with `no_engine` rather than falling back.
-- The reversal this slice depends on is exactly that operation.
--
-- WHY 'sarvam'. The net must catch the system where it stands, not where it is going: sarvam is what
-- both room rows resolve to today. A default pointing at the NEW engine would make the fallback a
-- second way to switch rather than a way to undo.
--
-- IDEMPOTENT. ON CONFLICT names the primary key verbatim from 0021_stt_routing.sql:14,
-- PRIMARY KEY (stage, language_bucket) — so re-running is a no-op and an existing row (if one is
-- added by hand before this runs) is never overwritten.
--
-- Slice C1 spec v1.1 §2.1. Applied by V on preview; the Builder runs no migration.
-- =====================================================================

INSERT INTO stt_routing (stage, language_bucket, engine_id)
VALUES ('room', 'default', 'sarvam')
ON CONFLICT (stage, language_bucket) DO NOTHING;
