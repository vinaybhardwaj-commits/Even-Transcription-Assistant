-- =====================================================================
-- Migration 0106 — jev_window_signal: Arm D's (`jev`) per-window Jev answers (Slice J2).
--
-- WHY (ETA-JEV-ARM-D-SPEC v1.1 §5.1). Arm D reads jev_window_text (J0, migration 0105) in
-- batches and asks Jev four questions per target window (phase, start, end, clinician) plus a
-- fifth (clinical). This table persists one row per TARGET window per Jev call ("batch_id");
-- context windows carried for surrounding evidence are never persisted from that batch. Read by
-- lib/brain/fuse/jev-arm.ts (pure) to produce DraftVisits, and by scribe_jev_signals (read-only).
--
-- ADDITIVE AND IDEMPOTENT. One new table, name-guarded index, no existing table touched, no
-- CHECK on an existing column changed. Rolls forward from the current head. App-owned: no GRANTs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS jev_window_signal (
  window_id        text PRIMARY KEY REFERENCES bench_window(id),
  room_day_id       text NOT NULL,
  session_id        text NOT NULL,
  start_ms          bigint NOT NULL,
  end_ms            bigint NOT NULL,
  phase             text NOT NULL CHECK (phase IN ('non_clinical','arrival','history','examination','plan','closing')),
  phase_probs       jsonb NOT NULL,
  phase_confidence  real NOT NULL,
  p_start           real NOT NULL,
  p_end             real NOT NULL,
  p_clinician       real NOT NULL,
  p_clinical        real NOT NULL,
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  input_tokens      int NOT NULL,
  batch_id          text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jev_window_signal_room_day
  ON jev_window_signal (room_day_id, start_ms);

COMMENT ON TABLE jev_window_signal IS
  'Slice J2 (ETA-JEV-ARM-D §5.1): one row per bench window Arm D asked Jev about, persisted by lib/jobs/kinds/jev-window.ts and consumed by lib/brain/fuse/jev-arm.ts. Bench-only; no production wiring.';
COMMENT ON COLUMN jev_window_signal.batch_id IS
  'Identifies the single Jev call this row came from (cost/latency accounting; never crosses room-days).';
COMMENT ON COLUMN jev_window_signal.prompt_version IS
  'jev-arm-d-v1, or skipped:no_english for a window with no jev_window_text.english (all p_* = 0).';

INSERT INTO schema_migrations (version, name)
VALUES (106, '0106_jev_window_signal')
ON CONFLICT DO NOTHING;
