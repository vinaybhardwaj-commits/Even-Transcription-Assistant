-- =====================================================================
-- Migration 0162 — the lab index-mirror run's exit.
--
-- NUMBERING: 0160 is kiosk_health_dedupe_boot_seq on main. 0161 is
-- release_rollout_and_sources on gating/ts-h8. This file is 0162 so it
-- does not take either number.
--
-- WHAT. consult/index/manifest.json, the object the hourly sync already
-- reads, does not carry the index-mirror process exit. POST
-- /api/consult-index/mirror-run stores that exit here, and the sync copies
-- exit_code from the manifest when a future writer adds it. Health reads
-- the latest row. Append-only. No consult uid, no room, no names.
--
-- ADDITIVE AND IDEMPOTENT. CREATE TABLE / INDEX IF NOT EXISTS. GRANTS: none
-- (app-owned, same as consult_index_sync). Down-migration:
-- db/rollbacks/0162_index_mirror_run.down.sql (run by hand, never from here).
-- =====================================================================

CREATE TABLE IF NOT EXISTS index_mirror_run (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  reported_at  timestamptz NOT NULL,
  exit_code    integer     NOT NULL,
  reason       text,
  source       text        NOT NULL,
  CONSTRAINT index_mirror_run_source_chk CHECK (source IN ('ingest', 'manifest')),
  CONSTRAINT index_mirror_run_reason_chk CHECK (reason IS NULL OR (
    char_length(reason) BETWEEN 1 AND 120 AND reason ~ '^[A-Za-z0-9_.:-]+$'
  ))
);

CREATE INDEX IF NOT EXISTS index_mirror_run_reported_idx ON index_mirror_run (reported_at DESC, id DESC);

INSERT INTO schema_migrations (version, name)
VALUES (162, '0162_index_mirror_run')
ON CONFLICT DO NOTHING;
