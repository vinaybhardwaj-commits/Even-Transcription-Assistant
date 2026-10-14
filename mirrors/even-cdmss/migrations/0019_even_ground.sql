-- 0019_even_ground.sql — Even LVC grounding worker (Phase 2, CDMSS-EVEN-LVC-GROUNDING-WORKER §3).
-- Reference DDL; the authoritative applier is POST /api/admin/migrate-even-ground (idempotent). Additive:
-- two new tables + one new ticks table; epoch/lock/paused live in the existing app_settings k/v store.
-- NOTHING existing is altered. finding_embeddings.embedding uses VECTOR with NO explicit dim — it must
-- equal mksap_chunks.embedding's nomic dim (INFERRED; validated live before the cron is enabled).

-- per-note grounding watermark (newest-first drain; avoids re-writing already-current notes)
CREATE TABLE IF NOT EXISTS even_ground_state (
  uid            TEXT PRIMARY KEY,               -- opd_note_audits.uid
  grounded_epoch BIGINT NOT NULL DEFAULT 0,
  grounded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  n_citations    INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS even_ground_state_epoch_idx ON even_ground_state (grounded_epoch);

-- finding-embedding cache (findings are immutable; embed once, reuse across sweeps)
CREATE TABLE IF NOT EXISTS finding_embeddings (
  finding_key TEXT PRIMARY KEY,                  -- sha256(uid ':' finding_ref-or-index ':' normalized_subject)
  embedding   VECTOR NOT NULL,                   -- SAME dim as mksap_chunks.embedding (nomic)
  subject_hash TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- observability tick log (mirrors the mini-backfill tick pattern; auto-pruned to 30d in-app)
CREATE TABLE IF NOT EXISTS even_ground_ticks (
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL,
  processed INT DEFAULT 0,
  citations_added INT DEFAULT 0,
  epoch BIGINT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS even_ground_ticks_ts_idx ON even_ground_ticks (ts DESC);

-- settings keys (existing app_settings k/v): even_ground_epoch (BIGINT-as-text, default 1),
-- even_ground_lock (ISO ts), even_ground_paused ('1'/'0'). No DDL — created on first write.
