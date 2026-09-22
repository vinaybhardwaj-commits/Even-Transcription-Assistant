-- Bench Live Equalizer v0.1.
--
-- Keep the latest zero-ratio on the listener row used by the fast fleet poll,
-- and append every measured main-mic heartbeat to an independent, PHI-free
-- room/day stream.  The date is materialized in IST so day reads do not depend
-- on the database or browser timezone.

ALTER TABLE bench_listener
  ADD COLUMN IF NOT EXISTS mic_zero_ratio real;

COMMENT ON COLUMN bench_listener.mic_zero_ratio IS
  'Fraction of near-zero samples in the latest main-mic heartbeat (0..1). NULL means the recorder did not report it.';

CREATE TABLE IF NOT EXISTS bench_level_sample (
  id                bigserial PRIMARY KEY,
  room_id           text NOT NULL REFERENCES room(id),
  ist_date          date NOT NULL,
  sampled_at        timestamptz NOT NULL DEFAULT now(),
  peak              real NOT NULL,
  avg               real,
  zero_ratio        real,
  session_open      boolean NOT NULL DEFAULT false,
  tape_advancing    boolean NOT NULL DEFAULT false,
  source            text NOT NULL DEFAULT 'command_poll'
);

CREATE INDEX IF NOT EXISTS bench_level_sample_room_day_time_idx
  ON bench_level_sample (room_id, ist_date, sampled_at);

COMMENT ON TABLE bench_level_sample IS
  'PHI-free main-microphone level heartbeats for the Bench room timeline. Contains levels and recorder state only; never audio.';

INSERT INTO schema_migrations (version, name)
VALUES (112, '0112_bench_level_samples')
ON CONFLICT DO NOTHING;
