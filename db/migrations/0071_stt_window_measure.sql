-- =====================================================================
-- Migration 0071 — what the tape actually contained, before anyone is scored on it.
--
-- WHY (ETA Transcription Programme PRD v1.0 §2–§3, Build 1). The layer that turns tape into
-- text is unmeasured. Whisper hallucinates on quiet windows, no window carries a statement of
-- how much of it was even measurable, and the three language opinions the drain has been
-- writing into transcription_run.metrics_json since K4b have never been read by anything.
--
-- These three tables are the free-signal stack. They are WRITE-ONLY-BY-THE-NIGHTLY-JOB and are
-- read by the operator surfaces; nothing here changes a single existing row, column or index.
--
--   stt_window_measure  one row per closed bench_window: how many milliseconds of it the level
--                       meter called energy, how many it called silence, how many it could not
--                       call at all, the measurability m, and — when m is below the floor — the
--                       reason the window is quarantined out of every score and every batch.
--
--   stt_window_score    one row per (window, engine): the derived numbers that only exist where
--                       a transcript exists — text_on_silence_ms, energy_no_text_ms. Kept OUT of
--                       transcription_run on purpose: a score is a later opinion about a run,
--                       and overwriting the run row would destroy the evidence it is an opinion
--                       about. §3: "never by overwriting run rows."
--
--   stt_canary_alarm    the tuning fork's drift record. One frozen ~90 s clip runs through local
--                       Whisper nightly; when the sha256 of its normalised transcript stops
--                       matching the stored reference, the transcriber changed underneath us and
--                       every measurement taken after that point is against a different
--                       instrument. A row here is that alarm.
--
-- NULL IS NOT SILENCE — MIGRATION 0066's RULE, RESTATED BECAUSE THIS IS THE FILE THAT COULD
-- BREAK IT. bench_chunk.peak_level NULL means "the meter was not measured", never "the room was
-- quiet": one is an absence of evidence and the other is evidence. That is why unknown_ms is a
-- COLUMN OF ITS OWN and not folded into silent_ms. A build that adds unknown_ms to silent_ms
-- would manufacture known-zero references out of unmeasured tape, and the entire silence
-- experiment (§6 E1) rests on those references being real.
--
-- WHY m IS numeric AND NOT A PERCENTAGE INTEGER. m is a ratio in [0,1] that a floor is compared
-- against (0.5). Storing it as an integer percent would make the floor comparison lossy at
-- exactly the boundary the quarantine decision turns on.
--
-- QUARANTINE REASON IS A CLOSED SET, ENFORCED BY CHECK. NO_LEVELS · LOW_COVERAGE ·
-- UNVERIFIED_CHUNKS · NO_AUDIO. A free-text reason column is how a closed set becomes an open
-- one over three builds; the CHECK makes a fifth reason a migration rather than a typo. NULL
-- means "not quarantined" and is the normal case for a measurable window.
--
-- ADDITIVE AND IDEMPOTENT. CREATE TABLE IF NOT EXISTS on three NEW tables. No existing table is
-- altered, no column is dropped, narrowed, renamed or retyped, no row is rewritten, and no
-- existing index is touched. Running it twice does nothing the second time. Until the nightly
-- job is deployed and scheduled these tables stay empty, and an empty measure table is exactly
-- what every reader is written to render as "not measured yet".
--
-- NOT TOUCHED: bench_window and bench_chunk (referenced only), transcription_run, stt_gold,
-- stt_engine, stt_routing, cue, room_day, visit, speaker_cluster.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The measure — one row per closed window.
--
-- window_id is BOTH the primary key and the foreign key: a window has exactly one measurement,
-- and re-running the nightly job UPSERTS that row rather than appending a second opinion. The
-- job's idempotency (§3 "Rerun is idempotent per window") is therefore a property of the
-- SCHEMA, not of the job's own care — a second writer cannot produce a duplicate even if it
-- races the first.
--
-- ON DELETE CASCADE: a measurement of a window that no longer exists is not evidence of
-- anything, and leaving it behind would make the coverage report count windows that are gone.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_window_measure (
  window_id         TEXT PRIMARY KEY REFERENCES bench_window(id) ON DELETE CASCADE,
  energy_ms         INTEGER NOT NULL DEFAULT 0,
  silent_ms         INTEGER NOT NULL DEFAULT 0,
  unknown_ms        INTEGER NOT NULL DEFAULT 0,
  m                 NUMERIC,
  quarantine_reason TEXT,
  confusability     SMALLINT,
  opinions_present  SMALLINT,
  proxy_version     TEXT,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stt_window_measure_quarantine_chk
    CHECK (quarantine_reason IS NULL OR quarantine_reason IN
           ('NO_LEVELS', 'LOW_COVERAGE', 'UNVERIFIED_CHUNKS', 'NO_AUDIO')),
  CONSTRAINT stt_window_measure_confusability_chk
    CHECK (confusability IS NULL OR confusability BETWEEN 0 AND 3),
  CONSTRAINT stt_window_measure_opinions_chk
    CHECK (opinions_present IS NULL OR opinions_present BETWEEN 0 AND 3)
);

COMMENT ON TABLE stt_window_measure IS
  'One row per closed bench_window: how much of it the level meter could speak to, and whether it is measurable enough to score. Written by the nightly measure job; never by the drain.';
COMMENT ON COLUMN stt_window_measure.energy_ms IS
  'Milliseconds of window time covered by a VERIFIED chunk whose peak_level is at or above the room floor. Sound was heard.';
COMMENT ON COLUMN stt_window_measure.silent_ms IS
  'Milliseconds covered by a VERIFIED chunk whose peak_level is below the room floor. The meter measured, and measured quiet. These are the known-zero references PRD §6 E1 spends its paid batch on.';
COMMENT ON COLUMN stt_window_measure.unknown_ms IS
  'Milliseconds covered by a chunk whose peak_level IS NULL. NOT SILENCE (migration 0066): the meter was never measured here. Kept separate so a quiet-looking window can never be built out of unmeasured tape.';
COMMENT ON COLUMN stt_window_measure.m IS
  'Measurability: (energy_ms + silent_ms) / window_ms, in [0,1]. Gap time, unverified-chunk time and unknown time cannot enter the numerator, so the discount PRD §2 asks for is structural rather than a second subtraction that would double-count it.';
COMMENT ON COLUMN stt_window_measure.quarantine_reason IS
  'NULL = measurable. Otherwise the closed-set reason this window is never scored, trended or batched: NO_AUDIO (no covering chunks) · NO_LEVELS (covered, but no chunk carries a level) · UNVERIFIED_CHUNKS (the unmeasured time is mostly chunks that never verified) · LOW_COVERAGE (everything else below the floor).';
COMMENT ON COLUMN stt_window_measure.confusability IS
  'Disagreement over the three stored language opinions (probe / full-window Whisper / Sarvam): 0 all the same code · 1 codes differ inside one bucket · 2 buckets split · 3 all three codes differ. NULL when no opinion was present at all — which is missing evidence, not agreement.';
COMMENT ON COLUMN stt_window_measure.opinions_present IS
  'How many of the three language opinions were actually non-null. Recorded SEPARATELY from confusability because a 0 computed over one opinion and a 0 computed over three are not the same claim.';
COMMENT ON COLUMN stt_window_measure.proxy_version IS
  'Which version of the measurement rules produced this row. A change to the floor, the bucketing or the discount is a new version, so a trend can never silently mix two instruments.';

-- The coverage report (§3: "the job''s first honest output is the coverage report itself") scans
-- by quarantine reason across all windows, and the job itself scans for windows not yet measured.
CREATE INDEX IF NOT EXISTS idx_stt_window_measure_quarantine
  ON stt_window_measure (quarantine_reason);
CREATE INDEX IF NOT EXISTS idx_stt_window_measure_computed
  ON stt_window_measure (computed_at DESC);

-- ---------------------------------------------------------------------
-- 2. The scores — one row per (window, engine), only where a transcript exists.
--
-- SEPARATE FROM THE MEASURE because they answer a different question and have a different
-- cardinality. A measure is a fact about the tape and there is exactly one per window; a score
-- is a fact about what an ENGINE did with that tape, and a window transcribed by two engines
-- has two. Folding them into one table would make every measure column repeat per engine and
-- would put the energy/silence facts at risk of disagreeing with themselves.
--
-- metrics_json rather than typed columns: the score vocabulary grows across Builds 2–4
-- (insertions_per_silent_second, refusal reasons, per-repeat variance) and each addition would
-- otherwise be a migration on a table whose rows are all recomputable anyway.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_window_score (
  window_id    TEXT NOT NULL REFERENCES bench_window(id) ON DELETE CASCADE,
  engine_key   TEXT NOT NULL,
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (window_id, engine_key)
);

COMMENT ON TABLE stt_window_score IS
  'Derived per-engine numbers for a window, kept out of transcription_run on purpose: a score is a later opinion ABOUT a run, and writing it onto the run destroys the evidence it is an opinion about (PRD §3).';
COMMENT ON COLUMN stt_window_score.engine_key IS
  'The adapter key that produced the text being scored, read from the cue payload that recorded the work — never typed. Bare text and no FK: an engine row can be retired from stt_engine without erasing the measurements taken while it ran.';
COMMENT ON COLUMN stt_window_score.metrics_json IS
  'Build 1 keys: text_on_silence_ms (transcript time landing inside chunk-grained quiet — hallucination on known-zero tape) and energy_no_text_ms (metered sound that produced no words). Both null-safe: a key is absent rather than zero when it could not be computed.';

CREATE INDEX IF NOT EXISTS idx_stt_window_score_engine
  ON stt_window_score (engine_key, computed_at DESC);

-- ---------------------------------------------------------------------
-- 3. The canary — the tuning fork's drift record.
--
-- kind is an OPEN set with no CHECK, matching `cue.type` next door. Build 1 writes exactly two:
-- TUNING_FORK_REFERENCE (the first run, storing the hash everything later is compared against)
-- and TUNING_FORK_DRIFT (a run whose hash did not match). Later builds add their own alarms and
-- a CHECK here would make each one a migration for no safety gained — this table is a log, and
-- an unrecognised kind in a log is readable, whereas a rejected INSERT loses the alarm.
--
-- APPEND ONLY. Nothing updates or deletes a row here. The reference is the OLDEST
-- TUNING_FORK_REFERENCE row, so a second reference written by mistake cannot silently become
-- the new truth and re-baseline a drift that already happened.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_canary_alarm (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE stt_canary_alarm IS
  'Append-only log of canary events. TUNING_FORK_REFERENCE stores the frozen clip''s first transcript hash; TUNING_FORK_DRIFT records a nightly run that no longer matches it, i.e. the transcriber changed under every measurement taken since.';
COMMENT ON COLUMN stt_canary_alarm.kind IS
  'Open set, no CHECK — this is a log, and an unrecognised kind is readable whereas a rejected INSERT loses the alarm.';

CREATE INDEX IF NOT EXISTS idx_stt_canary_alarm_kind
  ON stt_canary_alarm (kind, created_at DESC);

-- ---------------------------------------------------------------------
-- 4. Grants — saying no out loud.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc') THEN
    -- brain_svc reads cue, room_day, visit, speaker_cluster and room. These three tables belong
    -- to the STT measurement layer, which the brain neither writes nor reads, so nothing is
    -- granted. Recorded here rather than left to be inferred from silence — the absent grants of
    -- August cost an hour of diagnosis precisely because nobody had written down that they were
    -- absent on purpose (see 0053, 0066).
    RAISE NOTICE '0071: brain_svc exists and is deliberately granted nothing on stt_window_measure, stt_window_score or stt_canary_alarm';
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (71, '0071_stt_window_measure')
ON CONFLICT DO NOTHING;
