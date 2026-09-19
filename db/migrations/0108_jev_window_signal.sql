-- =====================================================================
-- Migration 0108 — jev_window_signal: Arm D's per-window text signals from Jev (Slice J2).
--
-- WHY (ETA-JEV-ARM-D-SPEC §5.1). Slice J2 reads each room window's English (jev_window_text, J0) and
-- asks Jev ("System One") a fixed set of typed questions per window — consultation phase (6-way),
-- and P(start) / P(end) / P(clinician) / P(clinical) — persisting the calibrated probabilities here.
-- The pure fusion (runJevArm → DraftVisits) reads THIS table; all thresholds/arbitration live in code.
--
-- MIGRATION NUMBER (Builder note): the order named 0107, but 0107 is already taken by
-- 0107_jev_role_signal on branch vinay/jev-arm-d (the unmerged monolithic Arm-D branch, which also
-- carries a 0106_jev_window_signal). run-migrations selects by version with ON CONFLICT DO NOTHING and
-- CANNOT report a clash, so reusing 0107 would silently skip one table's DDL at merge. 0108 is verified
-- FREE on every branch head and absent from the live DB (schema_migrations max = 105). Flagged for the
-- orchestrator to confirm/renumber. NOT APPLIED by the Builder.
--
-- AN ABSENCE AND A FAILURE NEVER SHARE A VALUE (the J0 lesson, brief rule). `status` tells four
-- situations apart by reading a row — never by overloading `phase` (non_clinical is a real answer):
--   not_ready — J0 has not produced usable English for this window yet (no jev_window_text row, or its
--               source is itself non-terminal), OR Jev is gated off (ETA_JEV_ENABLED unset). NOT
--               terminal: a normal re-run re-evaluates it and it becomes a real signal on its own.
--   empty     — J0 says the window is genuinely empty (english IS NULL, terminal source). Terminal.
--   failed    — Jev was asked and the call failed (transport/timeout/abort/bad-shape). Terminal for
--               that attempt, RETRYABLE (a re-run reprocesses it without force), reason in `error`.
--   ok        — Jev answered; the probabilities below are populated.
--
-- prompt_version is stored on every answered row so results stay comparable when wording changes
-- (programme rule). Probabilities are Jev's, verbatim; code gates on them, it does not recompute them.
--
-- ADDITIVE AND IDEMPOTENT. One new table, name-guarded index, no existing table touched. Column types
-- match the LIVE schema verified 19 Sep: bench_window.id is text (FK target), session_id text NOT NULL,
-- start_ms/end_ms bigint. App-owned: no GRANTs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS jev_window_signal (
  window_id        text        PRIMARY KEY REFERENCES bench_window(id),
  room_day_id      text        NOT NULL,
  session_id       text        NOT NULL,
  start_ms         bigint      NOT NULL,
  end_ms           bigint      NOT NULL,
  status           text        NOT NULL CHECK (status IN ('ok', 'not_ready', 'empty', 'failed')),
  phase            text        CHECK (phase IS NULL OR phase IN ('non_clinical', 'arrival', 'history', 'examination', 'plan', 'closing')),
  phase_probs      jsonb,                 -- Jev's per-phase probability map, for status='ok'
  phase_confidence real,
  p_start          real,                  -- P(a new patient's consultation begins in this window)
  p_end            real,                  -- P(the current visit ends in this window)
  p_clinician      real,                  -- P(the treating clinician speaks to the patient)
  p_clinical       real,                  -- P(the window contains clinical conversation)
  model            text,                  -- the Jev model that answered, for status='ok'
  prompt_version   text,                  -- the prompts module version (jev-arm-d-v1), for status='ok'
  error            text,                  -- CLOSED-CODE reason for status='failed'/'not_ready'; NULL for ok/empty
  input_tokens     int,                   -- the Jev call's input tokens; shared by all rows of one batch_id (cost = sum over distinct batch_id)
  batch_id         text,                  -- the one Jev call this row's answers came from
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jev_window_signal_room_day ON jev_window_signal (room_day_id, start_ms);

COMMENT ON TABLE jev_window_signal IS
  'Slice J2 (ETA-JEV-ARM-D §5.1): Arm D per-window text signals from Jev, written by lib/jobs/kinds/jev-window.ts and read by the pure runJevArm fusion. status keeps an absence (not_ready), an empty window (empty) and a failed Jev call (failed, retryable) apart from an answered window (ok).';
COMMENT ON COLUMN jev_window_signal.status IS
  'ok (Jev answered) | not_ready (no usable J0 english yet, or Jev gated off — NOT terminal, re-evaluated) | empty (J0 says genuinely empty — terminal) | failed (Jev call failed — retryable, reason in error).';
COMMENT ON COLUMN jev_window_signal.error IS
  'Closed-code reason for status=failed (jev_transport | jev_timeout | jev_bad_shape | jev_state_too_large) or not_ready (j0_not_ready | jev_disabled). Never an exception string or transcript. NULL for ok/empty.';
COMMENT ON COLUMN jev_window_signal.input_tokens IS
  'Input tokens of the Jev call (batch_id) this row came from; identical across the batch. Room-day cost = SUM over DISTINCT batch_id, not per row.';

INSERT INTO schema_migrations (version, name)
VALUES (108, '0108_jev_window_signal')
ON CONFLICT DO NOTHING;
