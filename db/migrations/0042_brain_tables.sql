-- =====================================================================
-- Migration 0042 — Ambient Brain tables (Brain PRD v1 §10 + §15A, designer
-- answers §6, 17 Aug 2026). Additive + idempotent.
--
-- Owned by the Cloud Run brain service (brain/ — its own pg pool over the
-- BRAIN_DATABASE_URL role, decision B8). The brain NEVER migrates; this file
-- runs through the ETA runner (/api/run-migrations) like every other one.
--
--   room_day        — one row per (room, IST date). Day boundary per §15A:
--                     no visit spans IST days; rollover job comes later.
--   visit           — one OPD thread for a person that day, incl. the
--                     diagnostics hole. end_reason exists from day one (§6).
--   speaker_cluster — same-IST-day voice slots. centroid = 192-dim ECAPA
--                     float32 (768 bytes, bytea). Dies at rollover (§2.7).
--   cue             — evidence log. type is an OPEN SET — deliberately NO
--                     CHECK constraint (PRD §3.5 "infinite cues, finite
--                     state"). payload nullable: §15A nulls it after 30 days
--                     and keeps the row for audit.
-- =====================================================================

CREATE TABLE IF NOT EXISTS room_day (
  id          text PRIMARY KEY,                     -- 'rd_' + id
  room_id     text NOT NULL REFERENCES room(id),    -- Room Bench room (0041)
  doctor_id   text,                                 -- clinician id, when known
  ist_date    date NOT NULL,                        -- calendar date in Asia/Kolkata
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,                          -- kiosk end-of-day or 23:59 IST rollover (later)
  UNIQUE (room_id, ist_date)                        -- resolve-or-create key for POST /cues
);

CREATE TABLE IF NOT EXISTS visit (
  id              text PRIMARY KEY,                 -- 'vis_' + id
  room_day_id     text NOT NULL REFERENCES room_day(id),
  individual_uid  text,                             -- Pulse person, when known (never mobile / patient_id / UHID)
  consult_uid     text,                             -- if we ever see it
  state           text NOT NULL DEFAULT 'unknown'
                    CHECK (state IN ('called','in_chair','at_diagnostics','ended','unknown')),
  pstart_at       timestamptz,                      -- from 7404 / PQM
  confidence      real,                             -- nullable: unsure is a first-class state
  end_reason      text,                             -- day_rollover | pulse_note | explicit_end | ... (open)
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS speaker_cluster (
  id             text PRIMARY KEY,                  -- 'sc_' + id
  room_day_id    text NOT NULL REFERENCES room_day(id),
  kind           text NOT NULL CHECK (kind IN ('doctor','other')),
  centroid       bytea,                             -- 192 × float32 LE = 768 bytes
  visit_id       text REFERENCES visit(id),         -- attached when we think we know
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cue (
  id           text PRIMARY KEY,                    -- 'cue_' + id
  room_day_id  text NOT NULL REFERENCES room_day(id),
  type         text NOT NULL,                       -- open set (stt_turn | speaker_match | pqm_called | dx_event | pulse_note | ...). NO CHECK.
  payload      jsonb,                               -- nullable (§15A 30-day payload null)
  at           timestamptz NOT NULL,                -- evidence time as posted, not arrival time
  created_at   timestamptz NOT NULL DEFAULT now()   -- arrival time (audit)
);

CREATE INDEX IF NOT EXISTS cue_room_day_at_idx             ON cue (room_day_id, at DESC);
CREATE INDEX IF NOT EXISTS visit_room_day_idx              ON visit (room_day_id);
CREATE INDEX IF NOT EXISTS speaker_cluster_room_day_idx    ON speaker_cluster (room_day_id);

INSERT INTO schema_migrations (version, name)
VALUES (42, '0042_brain_tables')
ON CONFLICT DO NOTHING;
