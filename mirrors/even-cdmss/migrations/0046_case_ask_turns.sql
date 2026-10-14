-- 0046_case_ask_turns.sql — the shared persisted case conversation for the OPD note audit and the
-- IPD discharge audit (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / O5).
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is
-- POST /api/admin/migrate-case-ask, which runs this DDL idempotently.
--
-- NO ENGINE BUMP anywhere. OPD stays 'opd-note-audit/0.81.21' and IPD stays
-- 'ipd-discharge-audit/0.2': nothing detected, audited or scored changes. This migration
-- adds storage for a conversation, and for nothing else.
--
-- READMISSIONS IS NOT TOUCHED. `readmission_ask_turns` (migration 0045) and the nine
-- `clinical_review_*` columns stay exactly as R9 shipped them; this is a SECOND, separate
-- table for the two surfaces that had no Ask at all.
--
-- case_ask_turns — one row per TURN, keyed (case_type, case_key, engine_version, turn_index).
-- The server is the thread's truth: the routes load the thread from here and ignore any
-- history a client passes.
--   case_type       'opd' | 'ipd'  — the case surface. Readmissions never writes here.
--   case_key        O6 — the OPD audit row id, or the IPD audit row id.
--   engine_version  the version the case was scored under, so a later engine's rows open a
--                   new thread rather than inheriting an argument about different numbers.
--   role            'user' | 'agent'
--   content         already de-identified on arrival (§3.3 covers stored turn content as
--                   well as model material)
--   actor           the ROLE the request proved — 'admin'. O8: there is no per-person
--                   reviewer identity in this app, and this ship does not invent one.
--   withheld        an agent turn that failed its citation check, OR the daily-ceiling
--                   refusal (O7). KEPT — "the agent could not answer that" is part of the
--                   record — and never replayed to the model.
--
-- DELIBERATELY ABSENT (O5): there is NO overlay column. OPD and IPD get no clinical_review
-- this ship. Nothing in this migration reads or writes a score, a band, a verdict or a
-- feedback row, and no column here can be joined into one.

CREATE TABLE IF NOT EXISTS case_ask_turns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  case_type       TEXT NOT NULL,
  case_key        TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  turn_index      INT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  actor           TEXT,
  withheld        BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS case_ask_turns_key_idx
  ON case_ask_turns (case_type, case_key, engine_version, turn_index);
-- O7's ceiling counts this thread's AGENT turns on the current IST day; the read is by thread
-- and then by day, so the thread key above already serves it. This second index keeps the
-- ceiling count cheap once a thread is long.
CREATE INDEX IF NOT EXISTS case_ask_turns_day_idx
  ON case_ask_turns (case_type, case_key, engine_version, role, created_at);
