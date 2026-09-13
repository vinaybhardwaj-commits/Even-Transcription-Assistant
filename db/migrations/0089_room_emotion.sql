-- 0089 — room emotion: the model's affect scores for attributed speech in a room window.
--
-- WHAT THESE TABLES HOLD. The output of one speech-emotion model
-- (Aniemore/wavlm-emotion-v1-crosslingual) over segments of a window's audio: a probability for each
-- of seven general-affect labels — anger, disgust, enthusiasm, fear, happiness, neutral, sadness.
-- The model was trained elsewhere and is not validated on this audio. These tables record what it
-- output. They do not record, and no column here is named for, any reading of what it means.
--
-- WHO SPOKE. A segment carries the diarize speaker index and the turns it was built from. It carries
-- no identity and no role: identity comes only from room_turn_speaker, where a role exists only for a
-- successful voiceprint match. A segment whose speaker has no role there is unattributed — not any
-- particular kind of person.
--
-- Written by the emotion_window job only (lib/jobs/kinds/emotion-window.ts). Nothing in this
-- migration is written to any existing table.

CREATE TABLE IF NOT EXISTS room_emotion_window (
  window_id         text PRIMARY KEY REFERENCES bench_window(id) ON DELETE CASCADE,
  room_day_id       text,
  state             text NOT NULL,
  -- The diarize run (room_diarize_window.last_run_id, 0090) whose turns the segments were planned from.
  diarize_run_id    text NOT NULL,
  attempts          integer NOT NULL DEFAULT 1,
  failure_history   jsonb NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  model             text,
  model_key         text,
  subfolder         text,
  cap_s             double precision,
  segments_planned  integer,
  segments_scored   integer,
  segments_skipped  integer,
  segments_failed   integer,
  calls             integer,
  warmup_json       jsonb,
  timing_json       jsonb,
  scored_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_emotion_window_state_chk CHECK (state IN ('ok', 'failed', 'no_segments')),
  CONSTRAINT room_emotion_window_attempts_chk CHECK (attempts >= 1),
  CONSTRAINT room_emotion_window_history_chk CHECK (jsonb_typeof(failure_history) = 'array'),
  CONSTRAINT room_emotion_window_error_chk CHECK ((state = 'failed') = (error IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS room_span_emotion (
  window_id         text NOT NULL REFERENCES bench_window(id) ON DELETE CASCADE,
  diarize_run_id    text NOT NULL,
  -- Wall-clock bounds of the run of turns this segment belongs to, and of this chunk of it.
  run_start_ms      bigint NOT NULL,
  run_end_ms        bigint NOT NULL,
  chunk_idx         integer NOT NULL,
  chunk_count       integer NOT NULL,
  segment_start_ms  bigint NOT NULL,
  segment_end_ms    bigint NOT NULL,
  room_day_id       text,
  speaker_idx       integer NOT NULL,
  -- The stt_turn source_refs merged into the run: the join back to room_turn_speaker and the cues.
  source_refs       text[] NOT NULL,
  -- The audio a reviewer would listen to: this object, from clip_start_s to clip_end_s.
  clip_r2_key       text,
  clip_start_s      double precision NOT NULL,
  clip_end_s        double precision NOT NULL,
  state             text NOT NULL,
  reason            text,
  anger             double precision,
  disgust           double precision,
  enthusiasm        double precision,
  fear              double precision,
  happiness         double precision,
  neutral           double precision,
  sadness           double precision,
  labels_json       jsonb,
  top_label         text,
  top_score         double precision,
  model             text,
  model_key         text,
  subfolder         text,
  device            text,
  inference_s       double precision,
  duration_s        double precision,
  -- The cap the segment was PLANNED under; the scoring call must report the same cap or the window fails.
  cap_s             double precision,
  scored_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx),
  CONSTRAINT room_span_emotion_state_chk CHECK (state IN ('scored', 'skipped', 'failed')),
  CONSTRAINT room_span_emotion_bounds_chk CHECK (segment_end_ms > segment_start_ms AND run_end_ms > run_start_ms
                                                 AND chunk_idx >= 0 AND chunk_count >= 1 AND chunk_idx < chunk_count),
  CONSTRAINT room_span_emotion_scored_chk CHECK (
    (state = 'scored') = (
      anger IS NOT NULL AND disgust IS NOT NULL AND enthusiasm IS NOT NULL AND fear IS NOT NULL
      AND happiness IS NOT NULL AND neutral IS NOT NULL AND sadness IS NOT NULL
      AND labels_json IS NOT NULL AND top_label IS NOT NULL AND top_score IS NOT NULL
    )
  ),
  CONSTRAINT room_span_emotion_reason_chk CHECK ((state = 'scored') = (reason IS NULL)),
  CONSTRAINT room_span_emotion_label_chk CHECK (top_label IS NULL OR top_label IN ('anger', 'disgust', 'enthusiasm', 'fear', 'happiness', 'neutral', 'sadness')),
  CONSTRAINT room_span_emotion_range_chk CHECK (
    COALESCE(anger, 0) BETWEEN 0 AND 1 AND COALESCE(disgust, 0) BETWEEN 0 AND 1 AND COALESCE(enthusiasm, 0) BETWEEN 0 AND 1
    AND COALESCE(fear, 0) BETWEEN 0 AND 1 AND COALESCE(happiness, 0) BETWEEN 0 AND 1 AND COALESCE(neutral, 0) BETWEEN 0 AND 1
    AND COALESCE(sadness, 0) BETWEEN 0 AND 1 AND COALESCE(top_score, 0) BETWEEN 0 AND 1
  )
);

CREATE INDEX IF NOT EXISTS idx_room_span_emotion_day ON room_span_emotion (room_day_id, segment_start_ms);
CREATE INDEX IF NOT EXISTS idx_room_emotion_window_state ON room_emotion_window (state, scored_at DESC);

COMMENT ON TABLE room_span_emotion IS
  'Model output (Aniemore/wavlm-emotion-v1-crosslingual): seven general-affect label probabilities per segment of attributed speech. Unvalidated on this audio. No identity or role column; join room_turn_speaker on source_refs.';
COMMENT ON COLUMN room_span_emotion.state IS
  'scored | skipped | failed (CHECK). scored rows carry all seven scores and the top label (CHECK); skipped and failed rows carry a reason and no scores (CHECK).';
COMMENT ON TABLE room_emotion_window IS
  'One row per window the emotion_window job handled. state ok | failed | no_segments (CHECK); failed carries error (CHECK). The retry bound is applied by the enqueue scan, not by the database.';

INSERT INTO schema_migrations (version, name)
VALUES (89, '0089_room_emotion')
ON CONFLICT DO NOTHING;
