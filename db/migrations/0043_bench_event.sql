-- =====================================================================
-- Migration 0043 — Bench events (Ambient Brain Kickoff C, consult mark,
-- 18 Aug 2026; decision C1). Additive + idempotent.
--
--   bench_event — durable record of a kiosk-originated event for a bench
--                 session. The brain-proxy writes this row FIRST, then
--                 forwards a best-effort cue to the brain; the row is the
--                 record, the brain cue is not.
--                 kind: open set — this build writes only 'consult_mark'.
--                 brain_status: 'sent' (brain answered 2xx) | 'failed'
--                 (written provisionally; stays 'failed' if the brain hop
--                 fails or times out).
-- ON DELETE RESTRICT mirrors bench_chunk (0041 D6): nothing deletes a
-- session that has evidence.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bench_event (
  id             text PRIMARY KEY,            -- 'be_' + id
  session_id     text NOT NULL REFERENCES bench_session(id) ON DELETE RESTRICT,
  kind           text NOT NULL,               -- 'consult_mark' (open set)
  at             timestamptz NOT NULL,        -- wall-clock of the press (client), not arrival
  brain_status   text NOT NULL,               -- 'sent' | 'failed'
  payload        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bench_event_session_idx ON bench_event (session_id);

INSERT INTO schema_migrations (version, name)
VALUES (43, '0043_bench_event')
ON CONFLICT DO NOTHING;
