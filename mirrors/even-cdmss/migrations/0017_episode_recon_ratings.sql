-- 0017_episode_recon_ratings — EpisodeState (#4) SL5: the reconstruction-fidelity bench store.
--
-- V's ratings of "does the assembled EpisodeState faithfully represent the documented course?" —
-- measured as COMPLETENESS (did the builder miss material facts) + PHASE-CORRECTNESS (is each fact
-- in the right pre/intra/post phase). This is BUILDER fidelity — a bench SEPARATE from the audit
-- engine's recall/precision (ipd_gold_adjudication) and from surface feedback (ipd_audit_feedback).
-- Its own table so it is independently queryable; STRICTLY not conflated with either of those.
--
-- DE-IDENTIFIED: refs + verdicts + notes only. The source documented course is shown READ-TIME on
-- the admin surface (the discharge PDF) and is NEVER persisted here. No PHI, no URLs.
-- Append-only; latest row per (document_id, version, phase, fact_ref) wins on read.

CREATE TABLE IF NOT EXISTS episode_recon_ratings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source   TEXT NOT NULL DEFAULT 'standalone',
  document_id  TEXT NOT NULL,          -- the episode's case ref (db13 doc id) — link-back key
  ip_uid       TEXT,                   -- admission link-back key
  version      TEXT NOT NULL,          -- the EpisodeState version rated (episode-state/0.2)
  phase        TEXT NOT NULL,          -- pre | intra | post
  fact_ref     TEXT,                   -- optional per-fact drill (NULL = phase-level rating)
  verdict      TEXT NOT NULL,          -- faithful | missed_material_fact | mis_phased | over_included
  note         TEXT
);

CREATE INDEX IF NOT EXISTS episode_recon_ratings_doc_idx ON episode_recon_ratings (document_id);
