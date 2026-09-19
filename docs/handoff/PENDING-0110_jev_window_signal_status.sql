-- =====================================================================
-- Migration 0110 — jev_window_signal.status/error: an absence must never share a value with a failure.
--
-- REQUIRES 0106_jev_window_signal (merged to vinay/s1-auto-drain at b5c29fe, unapplied; live head 105).
-- This ALTERs that table; it deliberately does NOT use ALTER TABLE IF EXISTS, because a missing
-- prerequisite must fail LOUDLY. A silent no-op here is the same class of bug this migration fixes.
--
-- WHY. As merged, 0106 has no way to say "we have not asked yet" or "we asked and the call failed":
--   * a window with no J0 english is written terminal as phase='non_clinical', p_*=0,
--     prompt_version='skipped:no_english' — indistinguishable on the row from Jev actually ANSWERING
--     'non_clinical';
--   * a window J0 has not reached yet fails the whole job (jev_english_missing), so one un-ready
--     window blocks an entire room-day instead of resolving on its own;
--   * a Jev outage has nowhere to go: no status, no reason, nothing retryable.
-- Four situations are now told apart by reading a row, and `error` carries a CLOSED code:
--   ok        — Jev answered; the probability columns are populated.
--   not_ready — no usable J0 english yet, or Jev gated off. NOT terminal: re-evaluated every run and
--               it becomes a real signal on its own. error = j0_not_ready | jev_disabled.
--   empty     — J0 says the window is genuinely empty. Terminal, error NULL.
--   failed    — Jev was asked and the call failed. Terminal for THAT attempt, RETRYABLE.
--               error = jev_transport | jev_state_too_large | jev_error.
--
-- BACKFILL maps the merged vocabulary onto the new one without losing information: the rows 0106's
-- code marked prompt_version='skipped:no_english' are exactly its "empty" windows; everything else it
-- wrote was an answered window.
--
-- RELAXING THE NOT NULLs is required, not cosmetic: a not_ready / empty / failed row has no phase, no
-- probabilities, no model and no batch, and 0106 declares all of them NOT NULL. Leaving them NOT NULL
-- would force the very placeholder values (phase='non_clinical', p_*=0) that caused the collapse.
--
-- VERSION 110 IN BOTH HALVES. run-migrations/route.ts takes the version from the FILENAME to decide
-- whether to skip, but the only thing that RECORDS a version is this file's own INSERT. If the two
-- disagree, this file's filename-version is never recorded (it re-runs for ever) and some other file's
-- version is marked applied and skipped for ever — and the runner cannot report either. Verified free
-- on every local and remote branch head before claiming: 0108 is voice_print_generation, 0109 is
-- room_clinician_attestation, 0110 is this. tests/unit/migrations-versions.test.ts now enforces it.
--
-- IDEMPOTENT. Re-running adds nothing twice; the CHECK is guarded on pg_constraint.
-- =====================================================================

ALTER TABLE jev_window_signal ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE jev_window_signal ADD COLUMN IF NOT EXISTS error  text;

-- Map what 0106's code already wrote onto the new vocabulary, before status becomes NOT NULL.
UPDATE jev_window_signal
   SET status = CASE WHEN prompt_version = 'skipped:no_english' THEN 'empty' ELSE 'ok' END
 WHERE status IS NULL;

ALTER TABLE jev_window_signal ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jev_window_signal_status_chk') THEN
    ALTER TABLE jev_window_signal
      ADD CONSTRAINT jev_window_signal_status_chk
      CHECK (status IN ('ok', 'not_ready', 'empty', 'failed'));
  END IF;
END
$$;

-- A not_ready / empty / failed row has none of these. NULL is the honest value; a placeholder is not.
ALTER TABLE jev_window_signal ALTER COLUMN phase            DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN phase_probs      DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN phase_confidence DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN p_start          DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN p_end            DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN p_clinician      DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN p_clinical       DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN model            DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN prompt_version   DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN input_tokens     DROP NOT NULL;
ALTER TABLE jev_window_signal ALTER COLUMN batch_id         DROP NOT NULL;

COMMENT ON COLUMN jev_window_signal.status IS
  'ok (Jev answered) | not_ready (no usable J0 english yet, or Jev gated off - NOT terminal, re-evaluated) | empty (J0 says genuinely empty - terminal) | failed (Jev call failed - retryable, reason in error).';
COMMENT ON COLUMN jev_window_signal.error IS
  'Closed-code reason: j0_not_ready | jev_disabled (not_ready); jev_transport | jev_state_too_large | jev_error (failed). Never an exception string or transcript. NULL for ok/empty.';

INSERT INTO schema_migrations (version, name)
VALUES (110, '0110_jev_window_signal_status')
ON CONFLICT DO NOTHING;
