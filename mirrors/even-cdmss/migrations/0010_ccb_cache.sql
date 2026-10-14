-- 0010_ccb_cache — CCB v2 P1 caching layer.
-- Two additive, independent caches. Neither holds anything the dossier/envelope did not already
-- return to the care manager; neither is on any model's input path.
--
--   ccb_member_snapshot — the assembled DossierBundle per member, TTL-refreshed.
--     Kills the ~7 live db13 reads on every member open. `individual_uid` is the same join-back
--     key ccb_briefs already stores. TTL + manual/nightly refresh (CCB_SNAPSHOT_TTL_H, default 24).
--
--   ccb_doc_extract — the de-identified ExtractedReport per result document, keyed by the
--     SHA-256 of its URL. IMMUTABLE, no TTL: a finalized PDF never changes. We store the HASH of
--     the URL, not the URL. The extract itself is already de-identified by the extractor
--     (name/uhid/mobile stripped) — identical posture to the stored envelope.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS. Safe to re-run. Shared Neon DB.

CREATE TABLE IF NOT EXISTS ccb_member_snapshot (
  individual_uid TEXT PRIMARY KEY,
  snapshot       JSONB NOT NULL,
  source         TEXT NOT NULL DEFAULT 'live',
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ccb_member_snapshot_refreshed_idx ON ccb_member_snapshot (refreshed_at DESC);

CREATE TABLE IF NOT EXISTS ccb_doc_extract (
  doc_sha    TEXT PRIMARY KEY,
  extract    JSONB NOT NULL,
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ccb_doc_extract_created_idx ON ccb_doc_extract (created_at DESC);
