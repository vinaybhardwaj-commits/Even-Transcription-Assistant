-- 0142_pulse_doctor_voice.sql — room voiceprints learned per PULSE doctor, with no roster.
--
-- Additive and idempotent; no grants. Written only by the pulse_doctor_voice job
-- (lib/jobs/kinds/pulse-doctor-voice.ts), which is enqueued only while PULSE_DOCTOR_VOICE_ENABLED is on.
-- Nothing a clinician sees reads these tables.
--
-- 1. pulse_doctor_voice — the learned ROOM print of one Pulse doctor uid: the voice that recurs across the Nemotron
--    windows of that doctor's single-doctor consults (lib/voice-room-print/recurring.ts). Versioned like
--    voice_centroid (0113/0115): one ACTIVE row per (pulse_doctor_uid, embedding_model); a rebuild is a new generation
--    that retires the old one with who and why; nothing is deleted. `nearest_clinician_id` / `nearest_score` are the
--    closest existing voice_print and its cosine: a SUGGESTION for a human, never a link.
-- 2. pulse_doctor_voice_run — one row per build attempt, built or refused, with its reason and counts, so "no print"
--    is always explained. No vector.
--
-- VOICE BIOMETRIC DATA AT REST in pulse_doctor_voice.embedding (as voice_centroid). Never logged.
--
-- One transaction (as 0140, 0141).

BEGIN;

CREATE TABLE IF NOT EXISTS pulse_doctor_voice (
  id                    text        PRIMARY KEY,
  pulse_doctor_uid      text        NOT NULL,
  generation            integer     NOT NULL,
  embedding             real[]      NOT NULL,
  embedding_model       text        NOT NULL,
  embedding_dim         integer     NOT NULL,
  n_windows             integer     NOT NULL,
  n_days                integer     NOT NULL,
  windows_offered       integer     NOT NULL,
  support               real        NOT NULL,
  runner_up_windows     integer     NOT NULL DEFAULT 0,
  nearest_clinician_id  text        NULL,
  nearest_score         real        NULL,
  source                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  retired_at            timestamptz NULL,
  retired_by            text        NULL,
  retired_reason        text        NULL,
  CONSTRAINT pulse_doctor_voice_generation_uq UNIQUE (pulse_doctor_uid, embedding_model, generation),
  CONSTRAINT pulse_doctor_voice_dim_chk CHECK (embedding_dim > 0 AND array_length(embedding, 1) = embedding_dim),
  CONSTRAINT pulse_doctor_voice_counts_chk CHECK (n_windows > 0 AND n_days > 0 AND windows_offered >= n_windows AND runner_up_windows >= 0),
  CONSTRAINT pulse_doctor_voice_support_chk CHECK (support > 0 AND support <= 1),
  CONSTRAINT pulse_doctor_voice_nearest_chk CHECK ((nearest_clinician_id IS NULL) = (nearest_score IS NULL)),
  CONSTRAINT pulse_doctor_voice_retirement_chk CHECK (retired_at IS NULL OR (retired_by IS NOT NULL AND retired_reason IS NOT NULL))
);

-- Not UNIQUE, as voice_centroid_active_idx: the retire and the insert share one statement, and the one-active rule is
-- kept by that statement plus the generation UNIQUE (a racing second writer computes the same generation and fails).
CREATE INDEX IF NOT EXISTS pulse_doctor_voice_active_idx
  ON pulse_doctor_voice (pulse_doctor_uid, embedding_model)
  WHERE retired_at IS NULL;

COMMENT ON TABLE pulse_doctor_voice IS
  'Room voiceprint learned per Pulse doctor uid from the recurring voice of their single-doctor consults (0142). One active row per (uid, model); retired rows kept. Voice biometric data at rest; never logged.';
COMMENT ON COLUMN pulse_doctor_voice.nearest_clinician_id IS
  'The closest active voice_print at build time (with nearest_score). A suggestion for a human to confirm; never read as a link.';
COMMENT ON COLUMN pulse_doctor_voice.source IS
  'Provenance: member window ids and labels, the thresholds used. Ids and counts only; never audio, never text.';

CREATE TABLE IF NOT EXISTS pulse_doctor_voice_run (
  id                 bigserial   PRIMARY KEY,
  pulse_doctor_uid   text        NOT NULL,
  outcome            text        NOT NULL,
  reason             text        NULL,
  windows_offered    integer     NOT NULL DEFAULT 0,
  windows_embedded   integer     NOT NULL DEFAULT 0,
  n_windows          integer     NOT NULL DEFAULT 0,
  n_days             integer     NOT NULL DEFAULT 0,
  runner_up_windows  integer     NOT NULL DEFAULT 0,
  n_blind_excluded   integer     NOT NULL DEFAULT 0,
  voice_id           text        NULL REFERENCES pulse_doctor_voice(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pulse_doctor_voice_run_outcome_chk CHECK (outcome IN ('built', 'refused', 'failed')),
  CONSTRAINT pulse_doctor_voice_run_reason_chk CHECK ((outcome = 'built') = (reason IS NULL)),
  CONSTRAINT pulse_doctor_voice_run_voice_chk CHECK ((outcome = 'built') = (voice_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS pulse_doctor_voice_run_uid_idx ON pulse_doctor_voice_run (pulse_doctor_uid, created_at DESC);

COMMENT ON TABLE pulse_doctor_voice_run IS
  'One row per pulse_doctor_voice build attempt: built (with the print it wrote), refused (with the recurring-voice reason) or failed (with an error code). Counts only; no vector.';

INSERT INTO schema_migrations (version, name)
VALUES (142, '0142_pulse_doctor_voice')
ON CONFLICT DO NOTHING;

COMMIT;
