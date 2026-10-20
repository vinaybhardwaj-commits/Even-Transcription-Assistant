-- =====================================================================
-- Migration 0173 — Spine S0: the tables of SPINE-PLAN §2. Schema only: no writer, no reader, no seed rows.
--
-- NUMBER. 0173 is registered to the spine by gating-lead (0172 is parked with OAuth). A live branch also carries 0173_mcp_blacklist_applied.sql; gating-lead owns the numbering.
-- NO IDENTITY, NO TEXT. No name, phone, transcript, note or prescription id column. spine_signal.attrs is limited by CHECK to the keys ids / quality / close_reason, and no key at any depth may match text|name|phone|patient|transcript|email|uhid (case-insensitive).
-- REFS ONLY. spine_artefact holds bucket + object key + sha256, never a body.
-- SHADOW. spine_config has no seed rows: a missing or malformed value means off.
--
-- FLAGS. spine_encounter.flags holds the merge flags, so an ambiguous encounter can be excluded from FreeScript (R1) and queried. The CHECK set equals every string
--   lib/spine/merge.ts can emit on origin/spine/s2-merge (83c41733), plus enc_conflict (S2 R5, ruled, not yet emitted). Each flag with its line:
--   clamped (:352), clamp_failed (:355), ambiguous (:359), multi_machine (:365, :367), covered_by_pulse (:374), pulse_overlap (:379, :380),
--   frozen (:485, emitted via the alias `fl = flags.get(g)`; the output sorts it into flags[] at :489 and :507). The passthrough at :524 is [].
--   enc_conflict: fable ruling 20 Oct 13:40 (S2 R5 item 2): a shared pulse_enc_id that fails the machine/overlap guard flags BOTH encounters.
--   The CHECK also requires a 1-D array (a nested '{{ambiguous}}' passes <@ but is refused by array_ndims).
--   spine_link.key_kind also admits pulse_enc_id (fable M2 ruling; merge.ts MATCH_KINDS :51).
--
--   READERS: the GIN index serves `flags @> ARRAY['ambiguous']` (and &&), NOT `'ambiguous' = ANY(flags)`, which measured a Seq Scan on 10k rows. Use @>.
--
-- ADDITIVE AND IDEMPOTENT. CREATE ... IF NOT EXISTS everywhere. No existing table is altered. GRANTS: none.
-- Down-migration: db/rollbacks/0173_spine.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS spine_signal (
  id           bigserial   PRIMARY KEY,
  proxy        text        NOT NULL CONSTRAINT spine_signal_proxy_chk CHECK (proxy IN ('pulse','pqm','acoustic','timeline','doctor_activity','cutter','caa','nemotron_window')),
  source_key   text        NOT NULL,
  source_rev   int         NOT NULL DEFAULT 1,
  room_id      text,
  t_open       timestamptz NOT NULL,
  t_close      timestamptz,
  observed_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  encounter_id text,
  attrs        jsonb       NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT spine_signal_attrs_chk CHECK (jsonb_typeof(attrs) = 'object' AND (attrs - ARRAY['ids','quality','close_reason']) = '{}'::jsonb
      AND NOT jsonb_path_exists(attrs, '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "text|name|phone|patient|transcript|email|uhid" flag "i")')),
  CONSTRAINT spine_signal_key_uq UNIQUE (proxy, source_key, source_rev),
  CONSTRAINT spine_signal_close_chk CHECK (t_close IS NULL OR t_close >= t_open)
);
CREATE INDEX IF NOT EXISTS spine_signal_room_open_idx ON spine_signal (room_id, t_open);
CREATE INDEX IF NOT EXISTS spine_signal_encounter_idx ON spine_signal (encounter_id) WHERE encounter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS spine_encounter (
  encounter_id   text        PRIMARY KEY
    CONSTRAINT spine_encounter_id_chk CHECK (encounter_id ~ '^enc_[a-z2-7]{16}$' AND encounter_id !~ '[0-9]{8}'),
  ist_date       date        NOT NULL,
  room_id        text,
  t_open         timestamptz NOT NULL,
  t_close        timestamptz,
  status         text        NOT NULL CONSTRAINT spine_encounter_status_chk CHECK (status IN ('candidate','confirmed','rejected','merged')),
  merged_into    text,
  anchor_proxy   text,
  boundary_rev   int         NOT NULL DEFAULT 0,
  merge_version  text        NOT NULL,
  reason         text,
  flags          text[]      NOT NULL DEFAULT '{}'
    CONSTRAINT spine_encounter_flags_chk CHECK (flags <@ ARRAY['ambiguous','multi_machine','pulse_overlap','clamped','clamp_failed','covered_by_pulse','frozen','enc_conflict']::text[] AND (array_ndims(flags) IS NULL OR array_ndims(flags) = 1)),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spine_encounter_close_chk CHECK (t_close IS NULL OR t_close >= t_open)
);
CREATE INDEX IF NOT EXISTS spine_encounter_date_room_idx ON spine_encounter (ist_date, room_id);
CREATE INDEX IF NOT EXISTS spine_encounter_flags_idx ON spine_encounter USING gin (flags);

CREATE TABLE IF NOT EXISTS spine_link (
  encounter_id text        NOT NULL REFERENCES spine_encounter (encounter_id),
  key_kind     text        NOT NULL CONSTRAINT spine_link_kind_chk CHECK (key_kind IN ('consult_uid','consult_key','pqm_uid','window_id','caa_uid','buddy_opaque','pulse_enc_id')),
  value        text        NOT NULL,
  basis        text        NOT NULL CONSTRAINT spine_link_basis_chk CHECK (basis IN ('exact','overlap','merge')),
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS spine_link_active_uq ON spine_link (key_kind, value) WHERE active;
CREATE INDEX IF NOT EXISTS spine_link_encounter_idx ON spine_link (encounter_id);

CREATE TABLE IF NOT EXISTS spine_artefact (
  id            bigserial   PRIMARY KEY,
  encounter_id  text        NOT NULL REFERENCES spine_encounter (encounter_id),
  stage         text        NOT NULL,
  engine        text        NOT NULL,
  version       text        NOT NULL,
  cfg8          text        NOT NULL,
  cut_version   text        NOT NULL,
  store         text        NOT NULL CONSTRAINT spine_artefact_store_chk CHECK (store IN ('r2','neon','box')),
  bucket        text,
  object_key    text,
  sha256        text,
  status        text        NOT NULL CONSTRAINT spine_artefact_status_chk CHECK (status IN ('ok','empty','failed','skipped')),
  source_table  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spine_artefact_key_uq UNIQUE (encounter_id, stage, engine, version, cfg8, cut_version)
);

CREATE TABLE IF NOT EXISTS spine_job (
  job_id           bigserial   PRIMARY KEY,
  encounter_id     text        NOT NULL REFERENCES spine_encounter (encounter_id),
  stage            text        NOT NULL,
  cut_version      text        NOT NULL,
  input_key        text        NOT NULL,
  status           text        NOT NULL CONSTRAINT spine_job_status_chk CHECK (status IN ('queued','leased','done','failed','dead','superseded','shadow')),
  priority         int         NOT NULL DEFAULT 0,
  attempts         int         NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  lease_owner      text,
  lease_until      timestamptz,
  last_error_class text        CONSTRAINT spine_job_error_class_chk CHECK (last_error_class IS NULL OR last_error_class IN ('transient','permanent','budget')),
  last_error_code  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  done_at          timestamptz,
  CONSTRAINT spine_job_key_uq UNIQUE (encounter_id, stage, cut_version, input_key)
);
CREATE INDEX IF NOT EXISTS spine_job_status_next_idx ON spine_job (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS spine_config (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spine_tick (
  id         bigserial   PRIMARY KEY,
  kind       text        NOT NULL,
  ticked_at  timestamptz NOT NULL DEFAULT now(),
  counts     jsonb       NOT NULL DEFAULT '{}'::jsonb CONSTRAINT spine_tick_counts_chk CHECK (jsonb_typeof(counts) = 'object')
);
CREATE INDEX IF NOT EXISTS spine_tick_at_idx ON spine_tick (ticked_at);

INSERT INTO schema_migrations (version, name)
VALUES (173, '0173_spine')
ON CONFLICT DO NOTHING;

COMMIT;
