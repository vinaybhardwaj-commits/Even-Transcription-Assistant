-- =====================================================================
-- Migration 0156 — epic #23 (f): calibrated patient-leave shadow table.
--
-- WHAT. encounter_timeline_shadow_run is one pre-STT timeline pass for a room-day.
-- encounter_timeline_shadow is one consult on that pass: start/end, calibrated confidence,
-- reason codes, and the cheap acoustic features for its 30 s rows.
--
-- A consult ends when the patient leaves. encounter_end_ms is the Pulse endConsult (the note),
-- stored beside the consult and never used as the consult end. url_clear is a reason code, not an end.
--
-- The 0.9 fusion that writes encounter_hypothesis (0146, shadow-v3) is unchanged. This table is the
-- calibrated lane. Nothing here is read by note generation. ENCOUNTER_TIMELINE_SHADOW stays off until
-- a person turns it on; this file does not set the flag.
--
-- NO PHI: no transcript, no names, no audio keys. Speaker letters live inside features (DOC, B, C, …).
-- room_day_id is not a foreign key: room_day lives on the brain database.
--
-- ADDITIVE AND IDEMPOTENT. No existing table is altered. GRANTS: none (app-owned).
-- Down-migration: db/rollbacks/0156_encounter_timeline_shadow.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS encounter_timeline_shadow_run (
  id                text        PRIMARY KEY,
  room_day_id       text        NOT NULL,
  model             text        NOT NULL,
  question_set_sha  text        NOT NULL,
  prompt_version    text        NOT NULL,
  calibration_sha   text        NOT NULL,
  gate_version      text        NOT NULL,
  fusion_version    text        NOT NULL,
  params            jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS encounter_timeline_shadow (
  id                text        PRIMARY KEY,
  run_id            text        NOT NULL REFERENCES encounter_timeline_shadow_run(id) ON DELETE CASCADE,
  room_day_id       text        NOT NULL,
  consult_key       text        NOT NULL,
  start_ms          bigint      NOT NULL,
  end_ms            bigint      NOT NULL,
  confidence        real,
  raw_confidence    real,
  reason_codes      text[]      NOT NULL,
  closed_by         text        NOT NULL,
  encounter_end_ms  bigint,
  jev_used          boolean     NOT NULL,
  cache_hit         boolean     NOT NULL,
  cache_key         text        NOT NULL,
  end_row           text,
  end_signal        text,
  late_start_p      real,
  kind              text,
  kind_conf         real,
  features          jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounter_timeline_shadow_span_chk CHECK (end_ms > start_ms),
  CONSTRAINT encounter_timeline_shadow_closed_by_chk CHECK (closed_by IN ('patient_left', 'next_start', 'tape_off', 'dead_mic', 'cap')),
  CONSTRAINT encounter_timeline_shadow_reasons_chk CHECK (
    reason_codes <@ ARRAY[
      'patient_left', 'voices_left', 'jev_end_row', 'next_start_bound', 'tape_off', 'dead_mic', 'cap',
      'no_patient_voice', 'uncalibrated_jev', 'acoustic_veto', 'note_submitted', 'late_start', 'late_start_refused',
      'weak_url_clear', 'zero_speech'
    ]::text[]
  ),
  CONSTRAINT encounter_timeline_shadow_features_chk CHECK (jsonb_typeof(features) = 'array')
);

CREATE INDEX IF NOT EXISTS encounter_timeline_shadow_cache_key_idx ON encounter_timeline_shadow (cache_key);
CREATE INDEX IF NOT EXISTS encounter_timeline_shadow_room_day_idx ON encounter_timeline_shadow (room_day_id, created_at DESC);
CREATE INDEX IF NOT EXISTS encounter_timeline_shadow_run_room_day_idx ON encounter_timeline_shadow_run (room_day_id, created_at DESC);

COMMENT ON TABLE encounter_timeline_shadow_run IS
  'Epic #23 (f) pre-STT timeline pass. Word-free. Written only when ENCOUNTER_TIMELINE_SHADOW is on or a timeline replay is asked.';
COMMENT ON TABLE encounter_timeline_shadow IS
  'One shadow consult. End is patient-leave, not the note. encounter_end_ms is endConsult when it exists. No speech text and no names.';

INSERT INTO schema_migrations (version, name)
VALUES (156, '0156_encounter_timeline_shadow')
ON CONFLICT DO NOTHING;

COMMIT;
