-- =====================================================================
-- Migration 0135 — REB step 2: reb_track_index, the Neon index of the palimpsest's R2 track store (REB-SPEC v2.3 section 4).
-- NUMBERING: 0134 is claimed by Arch #21 on the bus; main's head was 0133 when this was written (8 Oct 2026). GATING renumbers at merge if main has moved.
--
-- One row per track file in R2 (eta-lab-results, prefix reb/): the unique key is (window_id, layer, engine, version, config_hash, shadow).
-- R2 is authoritative; this table is only the index. POST /api/reb/index inserts with ON CONFLICT DO NOTHING, so a re-post is a no-op and a
-- different sha256 under the same key is reported as a conflict (HTTP 409), never overwritten.
-- No patient identifiers: window/room ids, engine names, R2 keys and hashes only.
--
-- ADDITIVE AND IDEMPOTENT (IF NOT EXISTS throughout; no transaction; plain statements for the Neon HTTP runner).
-- GRANTS: none. reb_track_index is APP-OWNED — written and read only by app/api/reb/index/route.ts through the app connection, the same as
-- 0118 / 0123 (app-owned: no GRANTs). No new role, and no grant to eta_audio_writer (the 0129/0130/0132 box read role): per the spec every
-- read goes through the route, never the database.
-- =====================================================================
CREATE TABLE IF NOT EXISTS reb_track_index (
  id           bigserial PRIMARY KEY,
  window_id    text        NOT NULL,
  ist_date     date        NOT NULL,
  room_id      text        NOT NULL,
  t0_ms        bigint,
  t1_ms        bigint,
  layer        text        NOT NULL,
  engine       text        NOT NULL,
  model        text,
  version      text        NOT NULL,
  config_hash  text        NOT NULL,
  shadow       boolean     NOT NULL DEFAULT false,
  status       text        NOT NULL CHECK (status IN ('ok', 'empty', 'failed', 'skipped')),
  reason       text,
  machine      text,
  r2_key       text        NOT NULL,
  sha256       text        NOT NULL,
  bytes        bigint,
  started_at   timestamptz,
  finished_at  timestamptz,
  indexed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reb_track_index_key UNIQUE (window_id, layer, engine, version, config_hash, shadow)
);

CREATE INDEX IF NOT EXISTS reb_track_index_ist_date_idx ON reb_track_index (ist_date);
CREATE INDEX IF NOT EXISTS reb_track_index_window_idx ON reb_track_index (window_id);
CREATE INDEX IF NOT EXISTS reb_track_index_layer_engine_idx ON reb_track_index (layer, engine);

INSERT INTO schema_migrations (version, name)
VALUES (135, '0135_reb_track_index')
ON CONFLICT DO NOTHING;
