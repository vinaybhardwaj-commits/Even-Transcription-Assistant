-- =====================================================================
-- Migration 0106 — voice_print_generation: insert-only history of every voiceprint a clinician has had.
--
-- WHY (S2b, 19 Sep 2026). Speaker identification has not fired once in production. voice_print holds
-- ONE row per clinician (doctor_id is the primary key), enrolled from a quiet clip; room audio scores
-- against it at a median of 0.594 (worst 0.505) with the room threshold at 0.65. A print built from
-- room audio has to sit BESIDE the old one, not replace it, or there is no way to say which is better
-- or to go back. The primary key makes "a second row in voice_print" impossible, so the second
-- generation lives here.
--
-- WHAT THIS DOES NOT DO. Nothing reads this table yet. The matcher still reads voice_print. Promoting
-- a generation is a separate, later change and V's call. voice_print is not altered, updated or read
-- by this migration except for the generation-1 backfill below.
--
-- generation 1 IS THE EXISTING voice_print ROW, copied verbatim (centroid, sample_count, samples_json,
-- enrolled_at). origin says how a generation was made: 'enrolment_clip' = the original quiet-clip
-- enrolment; 'room_audio' = mined from room recordings where the clinician was attested present.
-- provenance_json is ids and counts only (window ids, segment counts, seconds). No transcript text,
-- no patient or room labels.
--
-- INSERT-ONLY BY CONVENTION AND BY SHAPE: UNIQUE (clinician_id, generation) means a rerun of the
-- loader cannot overwrite a generation; it collides and does nothing. No UPDATE or DELETE is issued
-- anywhere in this change.
--
-- ADDITIVE. One new table. Re-runnable: CREATE ... IF NOT EXISTS, backfill ON CONFLICT DO NOTHING.
-- =====================================================================

CREATE TABLE IF NOT EXISTS voice_print_generation (
  id               text        PRIMARY KEY,
  clinician_id     text        NOT NULL REFERENCES clinician(id) ON DELETE CASCADE,
  generation       integer     NOT NULL,
  origin           text        NOT NULL,
  centroid         bytea       NOT NULL,
  sample_count     integer     NOT NULL DEFAULT 0,
  samples_json     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  provenance_json  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voice_print_generation_gen_chk    CHECK (generation >= 1),
  CONSTRAINT voice_print_generation_origin_chk CHECK (origin IN ('enrolment_clip', 'room_audio')),
  CONSTRAINT voice_print_generation_dim_chk    CHECK (octet_length(centroid) = 768),
  CONSTRAINT voice_print_generation_uniq       UNIQUE (clinician_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_voice_print_generation_clinician
  ON voice_print_generation (clinician_id, generation);

COMMENT ON TABLE voice_print_generation IS
  'Insert-only history of voiceprints per clinician (S2b). generation 1 = the voice_print row as it stood when this migration ran. Nothing reads this table yet; the matcher still reads voice_print.';
COMMENT ON COLUMN voice_print_generation.centroid IS
  'float32[192], little-endian, 768 bytes, RAW (not L2-normalised) — the same serialisation /enroll returns and voice_print.centroid stores. The arithmetic mean of the raw sample embeddings, accumulated in float32 like lib/enroll.ts averageEmbeddings.';
COMMENT ON COLUMN voice_print_generation.origin IS
  'enrolment_clip = the original quiet-clip enrolment (generation 1 backfill). room_audio = mined from room recordings where the clinician was attested present.';
COMMENT ON COLUMN voice_print_generation.provenance_json IS
  'Ids, counts and seconds only: source window ids, segment counts, total speech seconds, the manifest that attested presence. Never transcript text, patient or room labels.';

-- Generation 1: the existing prints, verbatim. Deterministic id so a rerun collides and does nothing.
INSERT INTO voice_print_generation (id, clinician_id, generation, origin, centroid, sample_count, samples_json, created_at)
SELECT 'vpg_' || vp.doctor_id || '_g1', vp.doctor_id, 1, 'enrolment_clip', vp.centroid, vp.sample_count, vp.samples_json, vp.enrolled_at
FROM voice_print vp
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (106, '0106_voice_print_generation')
ON CONFLICT DO NOTHING;
