-- =====================================================================
-- Migration 0107 — jev_role_signal: Slice J3's text role signal per diarized speaker/window.
--
-- WHY (ETA-JEV-ARM-D-SPEC v1.1 §6.1). Bench-only; does NOT feed room_turn_speaker in v1.0 (the
-- role column there stays NULL or 'clinician' from voiceprint matching only — this table never
-- widens that CHECK, per spec §9's forbidden list). Persisted by lib/jobs/kinds/jev-role.ts,
-- combined with the acoustic clinician flag by the pure lib/jev/role-composite.ts.
--
-- ADDITIVE AND IDEMPOTENT. One new table, no existing table touched, no CHECK on an existing
-- column changed. Rolls forward from 0106. App-owned: no GRANTs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS jev_role_signal (
  id               text PRIMARY KEY,
  window_id        text NOT NULL REFERENCES bench_window(id),
  room_day_id      text NOT NULL,
  speaker_idx      int NOT NULL,
  cluster_id       text,
  role             text NOT NULL CHECK (role IN ('clinician','patient','attendant','nurse_or_staff','other')),
  role_probs       jsonb NOT NULL,
  role_confidence  real NOT NULL,
  turn_count       int NOT NULL,
  char_count       int NOT NULL,
  model            text,
  prompt_version   text,
  input_tokens     int,
  batch_id         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jev_role_signal_window_speaker_prompt
  ON jev_role_signal (window_id, speaker_idx, prompt_version);

CREATE INDEX IF NOT EXISTS idx_jev_role_signal_room_day
  ON jev_role_signal (room_day_id);

COMMENT ON TABLE jev_role_signal IS
  'Slice J3 (ETA-JEV-ARM-D §6.1): text-derived role per diarized speaker per window. Bench-only; never feeds room_turn_speaker.role.';

INSERT INTO schema_migrations (version, name)
VALUES (107, '0107_jev_role_signal')
ON CONFLICT DO NOTHING;
