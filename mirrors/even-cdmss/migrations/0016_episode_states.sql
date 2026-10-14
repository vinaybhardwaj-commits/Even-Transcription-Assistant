-- 0016_episode_states — EpisodeState (#4) SL2 persistence.
--
-- One DE-IDENTIFIED phased-episode projection per audited discharge, built at IPD-audit time
-- (forward-only; no backfill). The `state` JSONB is the full EpisodeState — already de-identified
-- by construction (link-back keys + documented facts only; the toKxEnvelope mapper drops the db13
-- PHI before the object is ever built). Link-back keys (document_id / ip_uid) are re-identification
-- paths into db13 for an access-controlled surface — NEVER sent to an LLM.
--
-- Idempotent per admission: UNIQUE (document_id, version) → a re-audit refreshes the row in place.
-- Version-pinned so a schema bump (episode-state/0.2) coexists with 0.1 rather than clobbering it,
-- and SL5's reconstruction-fidelity gold can bench a specific version.

CREATE TABLE IF NOT EXISTS episode_states (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source   TEXT NOT NULL DEFAULT 'standalone',
  document_id  TEXT NOT NULL,          -- db13 miscellaneous_documents _doc_id (link-back key)
  ip_uid       TEXT,                   -- admission link-back key (ip_uid) — not PHI
  version      TEXT NOT NULL,          -- episode-state/0.1
  state        JSONB NOT NULL,         -- the FULL de-identified EpisodeState (facts + provenance)
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS episode_states_ip_uid_idx ON episode_states (ip_uid);
