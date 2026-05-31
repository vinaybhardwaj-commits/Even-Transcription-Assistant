-- =====================================================================
-- Migration 0017 — voice_sample: per-sample retention for clinician voiceprints.
-- Each enrollment clip (and, in Sprint B, each passively-captured encounter
-- match) becomes ONE row holding its 192-dim ECAPA embedding + (optional) a
-- reference to the raw audio in R2. The voice_print centroid becomes the
-- running average of all `included` rows here. Additive: voice_print keeps its
-- shape (still the centroid cache the diarize/identify paths read).
-- =====================================================================
CREATE TABLE IF NOT EXISTS voice_sample (
  id                   text PRIMARY KEY,
  clinician_id         text NOT NULL REFERENCES clinician(id) ON DELETE CASCADE,
  source               text NOT NULL DEFAULT 'enrollment',  -- 'enrollment' | 'passive'
  embedding            bytea NOT NULL,                        -- float32[192] (768 bytes)
  audio_r2_key         text,                                  -- raw clip (enrollment) | encounter audio (passive) | NULL (legacy)
  source_encounter_id  text,                                  -- passive only
  content_type         text,
  duration_ms          integer,
  session_id           text,                                  -- groups one enrollment session ('legacy' for backfill)
  sample_index         integer,
  match_confidence     double precision,                      -- passive capture confidence
  included             boolean NOT NULL DEFAULT true,         -- counted in the centroid average
  captured_by_admin_id text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_sample_clinician ON voice_sample(clinician_id);
CREATE INDEX IF NOT EXISTS idx_voice_sample_source    ON voice_sample(source);

-- Backfill: explode each voice_print.samples_json (array of base64 embeddings)
-- into per-sample rows so existing enrollment history is preserved. Audio was
-- never stored for these, so audio_r2_key stays NULL. Idempotent.
INSERT INTO voice_sample (id, clinician_id, source, embedding, session_id, sample_index, included, created_at)
SELECT 'vs_legacy_' || vp.doctor_id || '_' || s.ord,
       vp.doctor_id,
       'enrollment',
       decode(s.emb, 'base64'),
       'legacy',
       (s.ord)::int,
       true,
       vp.enrolled_at
FROM voice_print vp
CROSS JOIN LATERAL jsonb_array_elements_text(vp.samples_json) WITH ORDINALITY AS s(emb, ord)
WHERE jsonb_typeof(vp.samples_json) = 'array'
  AND length(s.emb) > 0
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name) VALUES (17, '0017_voice_sample') ON CONFLICT DO NOTHING;
