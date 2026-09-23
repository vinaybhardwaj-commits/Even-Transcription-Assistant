-- =====================================================================
-- Migration 0118 — E-6 fusion (shadow-runner v2): a run's SOURCE, and a Jev subject for a PROBE.
--
-- 1. encounter_hypothesis_run.source — 'acoustic' | 'fused'.
--    Shadow-runner v2 writes TWO runs per room-day from the same evidence: the acoustic-only run the
--    E-shadow already writes (probes → gate → smoother), and a fused run in which Jev's content
--    judgement confirms, splits or rejects each acoustic encounter. E-7 scores the two against the
--    PQM truth, so they must be told apart by a column, not by reading params. The source lives on
--    the RUN, because every interval of a run shares it; a reader takes the latest run of the source it
--    wants. Existing rows are acoustic by construction (the E-shadow is the only writer), which is
--    what the DEFAULT says — no row is rewritten.
--
-- 2. jev_decision.subject_type gains 'probe'.
--    v2 asks Jev about each 60 s probe of a room-day (U1 phase, U2 start/end, U6 clinical-or-not). A
--    probe is not a bench window, a turn, a note sentence, an encounter or a collapse — the five
--    types 0116 closed. Filing probe answers under 'window' would make subject_id mean a probe id in
--    rows whose type promises a bench_window id: a typed label that lies, which is the failure this
--    codebase has shipped before. The CHECK is widened by one value; nothing else in 0116 changes.
--    subject_id for a probe is `pr_<room_day_id>_<start_ms>` — stable, so a replay upserts rather than
--    duplicating (0116's key is (subject_type, subject_id, question_id, prompt_version)).
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS; each constraint is dropped-if-exists and re-added
-- with the wider set, which is a no-op on a second run. No row is rewritten. App-owned: no GRANTs.
-- =====================================================================

ALTER TABLE encounter_hypothesis_run
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'acoustic';

ALTER TABLE encounter_hypothesis_run DROP CONSTRAINT IF EXISTS encounter_hypothesis_run_source_chk;
ALTER TABLE encounter_hypothesis_run ADD CONSTRAINT encounter_hypothesis_run_source_chk
  CHECK (source IN ('acoustic', 'fused'));

CREATE INDEX IF NOT EXISTS encounter_hypothesis_run_day_source_idx
  ON encounter_hypothesis_run (room_day_id, source, created_at DESC);

COMMENT ON COLUMN encounter_hypothesis_run.source IS
  'acoustic = probes, gate and smoother only; fused = the same run with Jev confirming, splitting or rejecting each encounter (E-6). Shadow-runner v2 writes both from one evidence load.';

ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_subject_type_check;
ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_subject_type_chk;
ALTER TABLE jev_decision ADD CONSTRAINT jev_decision_subject_type_chk
  CHECK (subject_type IN ('window', 'turn', 'note_sentence', 'encounter', 'collapse', 'probe'));

-- 3. encounter_hypothesis.closed_by gains 'content_boundary'.
--    A fused run can SPLIT an acoustic encounter where Jev places a new patient's start inside it. The
--    earlier piece then closes for a reason none of the smoother's five values names, and borrowing one
--    ("non_speech", say) would record a reason that did not happen. The acoustic smoother never emits
--    it; lib/encounter-clock/smooth.ts CLOSED_BY carries it and a drift test compares the EFFECTIVE
--    CHECK (the last migration that defines it — this one) against that list.
ALTER TABLE encounter_hypothesis DROP CONSTRAINT IF EXISTS encounter_hypothesis_closed_by_chk;
ALTER TABLE encounter_hypothesis ADD CONSTRAINT encounter_hypothesis_closed_by_chk CHECK (
  closed_by IN ('non_speech', 'unjudged_gap', 'tape_off', 'dead_mic', 'end_of_input', 'content_boundary'));

INSERT INTO schema_migrations (version, name)
VALUES (118, '0118_encounter_fusion')
ON CONFLICT DO NOTHING;
