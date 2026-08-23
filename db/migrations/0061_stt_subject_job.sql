-- =====================================================================
-- Migration 0061 — the STT queue learns to hold a subject that is not an encounter
-- (22 Aug 2026). Step four of five.
--
-- stt_fanout_job is keyed on encounter_id and cannot express a bench_window. This REPLACES
-- it rather than widening it, because the table holds no history worth migrating: it is a
-- work queue, rows are transient, and a queue that has drained is empty by definition.
--
-- stt_fanout_job IS LEFT IN PLACE AND UNUSED. It is not dropped in this build and its rows
-- are not deleted. The retirement condition is written down so it is not guessed at later:
-- drop it only once a FULL encounter fan-out has been observed running end to end on
-- stt_subject_job in production. Until that has been seen, the old table is the way back.
--
-- THE KEY IS (subject_type, subject_id, tier). Tier is in the primary key because the ASR
-- and scribe tiers are separate work for the same subject and must be able to queue, run and
-- fail independently — collapsing them would make a scribe retry silently re-run ASR.
--
-- The partial index carries only the queued rows. A drained queue is the normal state, so an
-- index over every row would be mostly dead weight; this one is exactly the claim the drain
-- makes ("oldest queued first") and nothing else.
--
-- GRANTS: none. stt_subject_job is APP-OWNED, like stt_fanout_job before it and like
-- bench_window (0057). The brain role (brain_svc, 0053) has no business here.
--
-- NOT TOUCHED: stt_fanout_job in any particular, transcription_run, bench_window.
-- =====================================================================

CREATE TABLE IF NOT EXISTS stt_subject_job (
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'asr',
  state         TEXT NOT NULL DEFAULT 'queued',
  attempts      INT  NOT NULL DEFAULT 0,
  last_error    TEXT,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  PRIMARY KEY (subject_type, subject_id, tier),
  CONSTRAINT stt_subject_job_state_chk
    CHECK (state IN ('queued','running','done','failed'))
);

CREATE INDEX IF NOT EXISTS idx_stt_subject_job_queued
  ON stt_subject_job (state, queued_at) WHERE state = 'queued';

INSERT INTO schema_migrations (version, name)
VALUES (61, '0061_stt_subject_job')
ON CONFLICT DO NOTHING;
