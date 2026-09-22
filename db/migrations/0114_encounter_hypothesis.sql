-- =====================================================================
-- Migration 0114 — encounter_hypothesis: the E-5 store for the encounter clock (plan §3C).
--
-- WHAT IT HOLDS. The E-4 smoother (lib/encounter-clock/smooth.ts) turns one room-day's per-probe
-- speech verdicts into encounter intervals. This is where those intervals are kept, exactly as the
-- smoother returns them, so E-7 can score them against V's labels and a later E-3 pass can say
-- which clinician each one was.
--
--   encounter_hypothesis_run  ONE ROW PER SMOOTHER RUN over a room-day, written even when the run
--                             found no encounter. "Ran and found nothing" must be a row: an empty
--                             day and a day that was never run cannot share a value.
--   encounter_hypothesis      one row per interval, belonging to exactly one run.
--
-- APPEND-ONLY. A rerun is a new run; nothing is updated or deleted by the writer. Readers take the
-- latest run for a room-day; the older runs stay as history for the evaluation.
--
-- IDENTITY IS NULL UNTIL E-3. clinician_id / match_source / centroid_id / doctor_cosine are filled
-- only by a voiceprint match; the raw cosine is logged whether or not it cleared a threshold. A
-- heuristic role (the diarize service's guess, a Jev role label) is never written here as identity.
--
-- NO TEXT, NO AUDIO: times, counts, versions and ids only.
--
-- ADDITIVE AND IDEMPOTENT. Two new tables, their indexes, all IF NOT EXISTS; no existing table is
-- touched. App-owned: no GRANTs (0107, 0112, 0113).
-- =====================================================================

CREATE TABLE IF NOT EXISTS encounter_hypothesis_run (
  id                 text PRIMARY KEY,
  room_day_id        text NOT NULL,
  smoother_version   text NOT NULL,
  gate_version       text NOT NULL,
  params             jsonb NOT NULL DEFAULT '{}'::jsonb,
  probes_total       integer NOT NULL,
  probes_speech      integer NOT NULL,
  probes_non_speech  integer NOT NULL,
  probes_unjudged    integer NOT NULL,
  n_hypotheses       integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounter_hypothesis_run_counts_chk CHECK (
    probes_total >= 0 AND probes_speech >= 0 AND probes_non_speech >= 0 AND probes_unjudged >= 0
    AND probes_speech + probes_non_speech + probes_unjudged = probes_total
    AND n_hypotheses >= 0)
);

CREATE INDEX IF NOT EXISTS encounter_hypothesis_run_day_idx
  ON encounter_hypothesis_run (room_day_id, created_at DESC);

CREATE TABLE IF NOT EXISTS encounter_hypothesis (
  id                       text PRIMARY KEY,
  run_id                   text NOT NULL REFERENCES encounter_hypothesis_run(id) ON DELETE CASCADE,
  room_day_id              text NOT NULL,
  start_ms                 bigint NOT NULL,
  end_ms                   bigint NOT NULL,
  speech_probes            integer NOT NULL,
  non_speech_probes        integer NOT NULL,
  unjudged_ms              bigint NOT NULL,
  longest_unjudged_run_ms  bigint NOT NULL,
  dead_mic_ms              bigint NOT NULL,
  closed_by                text NOT NULL,
  merged_from              integer NOT NULL,
  doctor_yes               integer NOT NULL DEFAULT 0,
  doctor_no                integer NOT NULL DEFAULT 0,
  doctor_unknown           integer NOT NULL DEFAULT 0,
  clinician_id             text,
  match_source             text,
  centroid_id              text,
  doctor_cosine            real,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounter_hypothesis_span_chk CHECK (end_ms > start_ms),
  CONSTRAINT encounter_hypothesis_closed_by_chk CHECK (closed_by IN ('non_speech', 'end_of_input')),
  CONSTRAINT encounter_hypothesis_counts_chk CHECK (
    speech_probes >= 0 AND non_speech_probes >= 0 AND unjudged_ms >= 0
    AND longest_unjudged_run_ms >= 0 AND longest_unjudged_run_ms <= unjudged_ms
    AND dead_mic_ms >= 0 AND dead_mic_ms <= unjudged_ms AND merged_from >= 1
    AND doctor_yes >= 0 AND doctor_no >= 0 AND doctor_unknown >= 0),
  -- A clinician is named only together with the match that named it.
  CONSTRAINT encounter_hypothesis_identity_chk CHECK (
    clinician_id IS NULL OR (match_source IS NOT NULL AND doctor_cosine IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS encounter_hypothesis_run_start_idx
  ON encounter_hypothesis (run_id, start_ms);

COMMENT ON TABLE encounter_hypothesis_run IS
  'One row per E-4 smoother run over a room-day (plan §3C E-5), written even when it found no encounter. Append-only; readers take the latest run.';
COMMENT ON TABLE encounter_hypothesis IS
  'One encounter interval from a smoother run, as lib/encounter-clock/smooth.ts returns it. Epoch ms. Identity columns are NULL until an E-3 voiceprint match fills them. No text, no audio.';
COMMENT ON COLUMN encounter_hypothesis.doctor_cosine IS
  'The raw cosine of the E-3 match, logged whether or not it cleared the threshold. NULL until E-3 runs.';

INSERT INTO schema_migrations (version, name)
VALUES (114, '0114_encounter_hypothesis')
ON CONFLICT DO NOTHING;
