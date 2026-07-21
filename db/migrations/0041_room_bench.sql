-- =====================================================================
-- Migration 0041 — Room Bench (Room-Bench PRD v1.0 §3.1, 21 Jul 2026).
-- Additive + idempotent. Three new tables:
--   room          — bench room accounts (D5: separate class, NOT clinicians)
--   bench_session — one recording day per row
--   bench_chunk   — 5-minute self-contained WebM chunks (D1), R2 bench/ prefix
-- ON DELETE RESTRICT on bench_chunk→session is deliberate (D6: nothing
-- deletes a session that has chunks).
-- =====================================================================

CREATE TABLE IF NOT EXISTS room (
  id             text PRIMARY KEY,            -- 'room_' + id
  slug           text NOT NULL UNIQUE,        -- e.g. 'opd-3-k4hz' (token-suffixed like doctor slugs)
  name           text NOT NULL,               -- 'OPD 3'
  pin_hash       text NOT NULL,               -- bcrypt, same policy as doctor PINs
  failed_attempts integer NOT NULL DEFAULT 0, -- lockout fields mirror clinician's
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

CREATE TABLE IF NOT EXISTS bench_session (
  id             text PRIMARY KEY,            -- 'bs_' + id
  room_id        text NOT NULL REFERENCES room(id),
  label          text,                        -- e.g. 'OPD-3 · Dr Chandrika clinic'
  mic_label      text,                        -- free text, e.g. 'Jabra 410 USB'
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  status         text NOT NULL DEFAULT 'recording',  -- recording | paused | ended
  notes          text
);

CREATE TABLE IF NOT EXISTS bench_chunk (
  id             text PRIMARY KEY,            -- 'bc_' + id
  session_id     text NOT NULL REFERENCES bench_session(id) ON DELETE RESTRICT,
  idx            integer NOT NULL,            -- 0-based, monotonically increasing
  r2_key         text NOT NULL,
  content_type   text NOT NULL,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz NOT NULL,
  duration_ms    integer NOT NULL,
  size_bytes     bigint,
  upload_state   text NOT NULL DEFAULT 'pending', -- pending | verified | gap
  gap_before_ms  integer NOT NULL DEFAULT 0,  -- lost time before this chunk (crash/retry window)
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, idx)
);

INSERT INTO schema_migrations (version, name)
VALUES (41, '0041_room_bench')
ON CONFLICT DO NOTHING;
