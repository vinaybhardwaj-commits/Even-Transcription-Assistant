-- 0141_diarize_nemotron_identity.sql — epic #23 ticket (c): ECAPA identity on Nemotron speakers.
--
-- Additive and idempotent; no grants. Written only by the nemotron_identity job
-- (lib/jobs/kinds/nemotron-identity.ts), which is enqueued only while NEMOTRON_IDENTITY_ENABLED is on.
-- Nothing a clinician sees reads these tables.
--
-- 1. diarize_nemotron_identity — one row per (Nemotron window row, centroid set): did the pass run, and how.
--    `failed` rows carry attempts so the enqueue can stop at the bound; `ok` is final.
-- 2. diarize_nemotron_speaker — one row per Nemotron speaker per (window row, centroid set) (PRD §7.4):
--    who it matched, at what cosine, the candidate that lost, and whether a voiceprint was compared at all.
--
-- NO EMBEDDINGS. Neither table has a column for a vector; the job keeps embeddings in memory only.
--
-- One transaction (as 0140).

BEGIN;

CREATE TABLE IF NOT EXISTS diarize_nemotron_identity (
  window_row_id      bigint      NOT NULL REFERENCES diarize_nemotron_window(id) ON DELETE CASCADE,
  centroid_set       text        NOT NULL,
  state              text        NOT NULL,
  attempts           integer     NOT NULL DEFAULT 1,
  error_code         text        NULL,
  centroids_offered  integer     NOT NULL DEFAULT 0,
  speakers_embedded  integer     NOT NULL DEFAULT 0,
  shadow_trusted     boolean     NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT diarize_nemotron_identity_pk PRIMARY KEY (window_row_id, centroid_set),
  CONSTRAINT diarize_nemotron_identity_set_chk CHECK (centroid_set IN ('voice_print', 'voice_centroid:room_primary', 'confirmed6')),
  CONSTRAINT diarize_nemotron_identity_state_chk CHECK (state IN ('ok', 'failed')),
  CONSTRAINT diarize_nemotron_identity_error_chk CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT diarize_nemotron_identity_counts_chk CHECK (attempts >= 1 AND centroids_offered >= 0 AND speakers_embedded >= 0)
);

COMMENT ON TABLE diarize_nemotron_identity IS
  'One ECAPA identity pass per (diarize_nemotron_window row, centroid set). ok is final; failed carries attempts. Counts and codes only; no embeddings.';

CREATE TABLE IF NOT EXISTS diarize_nemotron_speaker (
  window_row_id        bigint      NOT NULL REFERENCES diarize_nemotron_window(id) ON DELETE CASCADE,
  centroid_set         text        NOT NULL,
  speaker_label        text        NOT NULL,
  speech_ms            integer     NOT NULL,
  clinician_id         text        NULL,
  match_confidence     real        NULL,
  losing_clinician_id  text        NULL,
  losing_score         real        NULL,
  centroids_offered    integer     NOT NULL,
  attribution          text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT diarize_nemotron_speaker_pk PRIMARY KEY (window_row_id, centroid_set, speaker_label),
  CONSTRAINT diarize_nemotron_speaker_label_chk CHECK (speaker_label ~ '^spk[0-9]{1,2}$'),
  CONSTRAINT diarize_nemotron_speaker_set_chk CHECK (centroid_set IN ('voice_print', 'voice_centroid:room_primary', 'confirmed6')),
  CONSTRAINT diarize_nemotron_speaker_attribution_chk CHECK (attribution IN ('voiceprint', 'none')),
  CONSTRAINT diarize_nemotron_speaker_counts_chk CHECK (speech_ms >= 0 AND centroids_offered >= 0),
  -- a clinician is named only with the match that named it, and only where a voiceprint was compared
  CONSTRAINT diarize_nemotron_speaker_match_chk CHECK (
    clinician_id IS NULL OR (match_confidence IS NOT NULL AND attribution = 'voiceprint')),
  -- a losing candidate exists only for a speaker nobody claimed
  CONSTRAINT diarize_nemotron_speaker_losing_chk CHECK (
    (losing_clinician_id IS NULL) = (losing_score IS NULL) AND (losing_clinician_id IS NULL OR clinician_id IS NULL))
);

COMMENT ON TABLE diarize_nemotron_speaker IS
  'Per Nemotron speaker: the ECAPA match against the centroid set (threshold DIARIZE_BATCH_THRESHOLD), the losing candidate, and attribution. Ids and scores only; never an embedding, never a name.';

INSERT INTO schema_migrations (version, name)
VALUES (141, '0141_diarize_nemotron_identity')
ON CONFLICT DO NOTHING;

COMMIT;
