-- =====================================================================
-- Migration NNNN — ENC module (ENC-1): daily per-room encounter isolation + steward.
--
-- NUMBER: PLACEHOLDER. gating-lead assigns the number. The file is named NNNN_enc_module.sql
-- and the schema_migrations row below uses version 9999 as a stand-in. The owner of the
-- rename changes BOTH (file prefix and the version/name in the INSERT).
--
-- WHAT. Five tables: enc_room_day, enc_isolation (filled by /api/admin/enc-sync from R2),
-- steward_run, steward_item, steward_settings (filled through /api/admin/steward/*).
-- Ids, times, counts and flags only. No transcript text, no names.
--
-- ADDITIVE AND IDEMPOTENT. CREATE TABLE / INDEX IF NOT EXISTS. GRANTS: none (app-owned).
-- Down-migration: db/rollbacks/ (run by hand, never from here).
-- =====================================================================

CREATE TABLE IF NOT EXISTS enc_room_day (
  ist_date          date        NOT NULL,
  room_id           text        NOT NULL,
  visits            integer     NOT NULL DEFAULT 0,
  placed            integer     NOT NULL DEFAULT 0,
  isolated          integer     NOT NULL DEFAULT 0,
  isolated_pulse    integer     NOT NULL DEFAULT 0,
  isolated_pqm      integer     NOT NULL DEFAULT 0,
  not_isolated      integer     NOT NULL DEFAULT 0,
  lane_sarvam       integer     NOT NULL DEFAULT 0,
  lane_nemotron     integer     NOT NULL DEFAULT 0,
  lane_role         integer     NOT NULL DEFAULT 0,
  lane_parts        integer     NOT NULL DEFAULT 0,
  rx_matched        integer     NOT NULL DEFAULT 0,
  tape_hours        numeric     NOT NULL DEFAULT 0,
  status            text        NOT NULL,
  alerts            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  computed_at       timestamptz NOT NULL,
  source            text        NOT NULL,
  PRIMARY KEY (ist_date, room_id),
  CONSTRAINT enc_room_day_status_chk CHECK (status IN ('ok', 'warn', 'alert', 'nodata')),
  CONSTRAINT enc_room_day_alerts_chk CHECK (jsonb_typeof(alerts) = 'array')
);

CREATE TABLE IF NOT EXISTS enc_isolation (
  consult_uid     text        PRIMARY KEY,
  ist_date        date        NOT NULL,
  room_id         text        NOT NULL,
  doctor_uid      text,
  t_start         timestamptz NOT NULL,
  t_end           timestamptz NOT NULL,
  boundary_source text        NOT NULL,
  room_source     text,
  confidence      numeric,
  status          text        NOT NULL,
  skip_reason     text,
  r2_prefix       text,
  lanes           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  parts           jsonb,
  rx              jsonb,
  pqm_step_uid    text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enc_isolation_boundary_chk CHECK (boundary_source IN ('pulse', 'pqm', 'hyp', 'refined')),
  CONSTRAINT enc_isolation_status_chk CHECK (status IN ('cut', 'skipped', 'deferred', 'planned'))
);

CREATE INDEX IF NOT EXISTS enc_isolation_room_date_idx ON enc_isolation (room_id, ist_date);

CREATE TABLE IF NOT EXISTS steward_run (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  mode        text        NOT NULL,
  model       text,
  tokens_in   integer,
  tokens_out  integer,
  cost_usd    numeric,
  summary_md  text,
  status      text        NOT NULL DEFAULT 'running',
  CONSTRAINT steward_run_mode_chk CHECK (mode IN ('advise', 'act'))
);

CREATE INDEX IF NOT EXISTS steward_run_started_idx ON steward_run (started_at DESC);

CREATE TABLE IF NOT EXISTS steward_item (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid        NOT NULL REFERENCES steward_run (id),
  kind            text        NOT NULL,
  ist_date        date        NOT NULL,
  room_id         text,
  consult_uid     text,
  title           text        NOT NULL,
  body_md         text        NOT NULL,
  proposed_action jsonb,
  state           text        NOT NULL DEFAULT 'open',
  decided_by      text,
  decided_at      timestamptz,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steward_item_kind_chk CHECK (kind IN ('suggestion', 'action', 'question')),
  CONSTRAINT steward_item_state_chk CHECK (state IN ('open', 'approved', 'rejected', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS steward_item_state_idx ON steward_item (state, created_at);
CREATE INDEX IF NOT EXISTS steward_item_run_idx ON steward_item (run_id);

CREATE TABLE IF NOT EXISTS steward_settings (
  key    text  PRIMARY KEY,
  value  jsonb NOT NULL
);

INSERT INTO schema_migrations (version, name)
VALUES (9999, 'NNNN_enc_module')
ON CONFLICT DO NOTHING;
