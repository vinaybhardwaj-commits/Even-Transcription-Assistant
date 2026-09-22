-- =====================================================================
-- Migration 0113 — voice_centroid: source-conditioned voiceprint centroids (plan §D).
--
-- WHY. voice_print (0007) holds ONE centroid per clinician, whatever mic or room it was built from.
-- Measured on 21 Sep: one clinician's recurring phone-session voice scored 0.598 cosine against
-- their stored print, and 5 of 7 stored prints scored under 0.65 against room audio. One centroid
-- per clinician does not serve both domains. This table holds one ACTIVE centroid per
-- (clinician, domain, embedding model), versioned by `generation`, so a room matcher reads the room
-- centroid and a phone matcher the phone one, and a rebuilt centroid supersedes without deleting.
--
--   domain           room_primary | phone | meet (CHECK). Closed set; widening it is a migration.
--   generation       1, 2, … per (clinician_id, domain, embedding_model). A new build takes the next
--                    number; the previous row gets retired_at. History is kept, never rewritten.
--   embedding        real[] of embedding_dim values from embedding_model (e.g. ECAPA, 192).
--   n_samples        how many samples were averaged into it.
--   source           provenance of the build (sessions/windows used, seconds, who built it).
--                    Ids and counts only: never transcript text, never audio.
--   retired_at       NULL = active. At most one active row per (clinician, domain, model) is the
--                    writer's rule (lib/voice-centroid.ts), not a constraint here — see the flag in
--                    the build report.
--
-- RETIREMENT PROVENANCE (retired_by, retired_reason) IS MIGRATION 0115, NOT THIS FILE. It was written
-- here first; an environment that had already applied this version would never have received the new
-- columns, because the runner skips a migration by version number. 0115 adds them with
-- ADD COLUMN IF NOT EXISTS, so every environment converges whatever it has applied.
--
-- Voice biometric data at rest, the same category as voice_print.centroid and
-- room_diarize_window.speakers_json, under the same (app-owned) grants.
--
-- ADDITIVE AND IDEMPOTENT. One new table, one unique constraint, one partial index, all IF NOT EXISTS.
-- No existing table is touched. App-owned: no GRANTs (the convention of 0107 and 0112; only the
-- brain graph grants to brain_svc, 0053).
-- =====================================================================

CREATE TABLE IF NOT EXISTS voice_centroid (
  id              text PRIMARY KEY,
  clinician_id    text NOT NULL,
  domain          text NOT NULL,
  generation      integer NOT NULL DEFAULT 1,
  embedding       real[] NOT NULL,
  embedding_model text NOT NULL,
  embedding_dim   integer NOT NULL,
  n_samples       integer NOT NULL,
  source          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz DEFAULT now(),
  retired_at      timestamptz,
  CONSTRAINT voice_centroid_domain_chk CHECK (domain IN ('room_primary', 'phone', 'meet')),
  CONSTRAINT voice_centroid_generation_uq UNIQUE (clinician_id, domain, embedding_model, generation)
);

CREATE INDEX IF NOT EXISTS voice_centroid_active_idx
  ON voice_centroid (clinician_id, domain)
  WHERE retired_at IS NULL;

COMMENT ON TABLE voice_centroid IS
  'Source-conditioned voiceprint centroids (plan §D): one active row per (clinician_id, domain, embedding_model), versioned by generation; retired rows are kept. Voice biometric data at rest.';
COMMENT ON COLUMN voice_centroid.domain IS
  'room_primary | phone | meet (CHECK). The capture domain the centroid was built from and is matched against.';
COMMENT ON COLUMN voice_centroid.retired_at IS
  'NULL = active. A new generation retires the previous one; nothing is deleted.';
COMMENT ON COLUMN voice_centroid.source IS
  'Provenance of the build: ids, counts, seconds. Never transcript text, never audio.';

INSERT INTO schema_migrations (version, name)
VALUES (113, '0113_voice_centroid')
ON CONFLICT DO NOTHING;
