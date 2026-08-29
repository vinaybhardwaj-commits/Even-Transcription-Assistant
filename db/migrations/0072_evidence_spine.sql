-- =====================================================================
-- Migration 0072 — the evidence spine.
--
-- WHY (ETA Transcription Programme PRD v1.0 §2 and §4, Build 2). Build 1 made the TAPE honest:
-- every window now says how much of it was measurable. This build makes the RUN honest. Today a
-- paid transcription row records what came back and nothing about how it came to exist — no
-- initiator, no provider-reported engine version, no fingerprint of the bytes that were sent.
-- Grounding §2 confirmed it: "no initiator — CONFIRMED", and the admin id is already resolved at
-- both HTTP entry points and then thrown away.
--
-- A number without a receipt is an anecdote. Four things ship here:
--
--   RECEIPTS      seven nullable columns on transcription_run plus a GENERATED receipt_complete,
--                 so "is this run auditable" is a column and not a convention.
--
--   FAMILIES      stt_engine_family turns "an engine is never scored against a window its own
--                 family transcribed" into a JOIN. A string compare would call `elevenlabs` and
--                 `elevenlabs_scribe` different engines, and the second is the first wearing a
--                 note-generator, so it would score against its own output and win.
--
--   ROOM GOLD     stt_gold_window, keyed on bench_window.id. The encounter-keyed `stt_gold` is
--                 UNTOUCHED: its PK *is* encounter_id with an FK to encounter, which is why a
--                 room window could never be a gold subject and why this is a new table rather
--                 than a widening of that one.
--
--   REFUSALS      stt_score_refusal. Every (window, engine) pair the scorer declines says so, in
--                 a closed vocabulary. The leaderboard may not publish WER without it.
--
-- NO BACKFILL, DELIBERATELY. Legacy rows get nothing. A run that predates this migration cannot
-- be made auditable after the fact, and inventing an initiator for it would be worse than the
-- gap: it would be a receipt that says a person pressed a button nobody pressed. They are
-- refusable as LEGACY_UNRECEIPTED, and `schema_migrations.applied_at` for version 72 is the
-- cutoff that tells LEGACY_UNRECEIPTED apart from NO_RECEIPT.
--
-- THE 0058 TRAP APPLIES AGAIN, AND IS WHY EVERY COLUMN HERE IS NULLABLE WITH NO DEFAULT.
-- 0058 recorded that five live code paths INSERT into transcription_run with an explicit column
-- list and four of them swallow insert errors into a warnings array — so a NOT NULL addition
-- fails SILENTLY. Nothing added here is NOT NULL, and nothing has a default.
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS on one existing table; three new tables; one
-- INSERT…SELECT guarded by ON CONFLICT DO NOTHING. No column is dropped, narrowed, renamed or
-- retyped; no existing row is rewritten.
--
-- NOT TOUCHED: stt_gold (the encounter table), stt_engine, stt_routing, bench_window and
-- bench_chunk (referenced only), stt_window_measure / stt_window_score / stt_canary_alarm (0071),
-- cue, room_day, visit, speaker_cluster.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Receipts on transcription_run.
--
-- WHY receipt_complete IS GENERATED AND NOT A WRITTEN BOOLEAN. A written flag is a second copy
-- of a fact that already exists in four columns, and the two can disagree — which is precisely
-- how a run with a NULL initiator ends up flagged auditable. GENERATED ALWAYS means the answer
-- is recomputed from the evidence on every read and cannot be set by a caller at all.
--
-- The four fields it names are PRD §2's definition of a receipt, minus the byte range: initiator,
-- initiated-via, provider-returned engine version, and the sha256 of the audio. The byte range is
-- recorded but is NOT part of completeness — a whole-object send has a trivially derivable range,
-- and requiring it would make completeness turn on a field that carries no independent evidence.
-- ---------------------------------------------------------------------
ALTER TABLE transcription_run
  ADD COLUMN IF NOT EXISTS initiated_by            text,
  ADD COLUMN IF NOT EXISTS initiated_via           text,
  ADD COLUMN IF NOT EXISTS engine_version_reported text,
  ADD COLUMN IF NOT EXISTS audio_r2_key            text,
  ADD COLUMN IF NOT EXISTS audio_byte_start        bigint,
  ADD COLUMN IF NOT EXISTS audio_byte_end          bigint,
  ADD COLUMN IF NOT EXISTS audio_sha256            text;

-- The CHECK is added separately and guarded, because ADD COLUMN IF NOT EXISTS cannot carry one
-- idempotently. NOT VALID is deliberate: legacy rows are all NULL and pass anyway, but NOT VALID
-- means the statement cannot take a long lock scanning a large table on a live database.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transcription_run_initiated_via_chk'
  ) THEN
    ALTER TABLE transcription_run
      ADD CONSTRAINT transcription_run_initiated_via_chk
      CHECK (initiated_via IS NULL OR initiated_via IN ('mcp', 'admin_route', 'cron')) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'transcription_run' AND column_name = 'receipt_complete'
  ) THEN
    ALTER TABLE transcription_run
      ADD COLUMN receipt_complete boolean
      GENERATED ALWAYS AS (
        initiated_by IS NOT NULL
        AND initiated_via IS NOT NULL
        AND engine_version_reported IS NOT NULL
        AND audio_sha256 IS NOT NULL
      ) STORED;
  END IF;
END
$$;

COMMENT ON COLUMN transcription_run.initiated_by IS
  'Who asked for this run. A JWT-resolved admin id, or the literal ''system:cron'' for an unattended path. NULL on every row written before migration 0072 — never backfilled, because an invented initiator is worse than an absent one.';
COMMENT ON COLUMN transcription_run.initiated_via IS
  'Which door it came through: mcp | admin_route | cron. Bare text with a CHECK, matching the table''s existing style.';
COMMENT ON COLUMN transcription_run.engine_version_reported IS
  'The engine version THE PROVIDER RETURNED, copied verbatim. Never the model string we sent — this system has shipped a typed provider label twice and both times it hid a wrong provider for months. NULL when the provider''s response carries no version.';
COMMENT ON COLUMN transcription_run.audio_sha256 IS
  'sha256 of the exact bytes handed to the engine, so a disputed transcript can be re-run against provably identical audio.';
COMMENT ON COLUMN transcription_run.receipt_complete IS
  'GENERATED, never written: initiator AND via AND provider-reported version AND audio sha256 all present. A stored boolean would be a second copy of a fact that can disagree with the fact.';

-- The scorer reads receipts per subject; the spend ledger groups by initiator and day.
CREATE INDEX IF NOT EXISTS idx_transcription_run_initiated_by
  ON transcription_run (initiated_by, created_at);

-- ---------------------------------------------------------------------
-- 2. The engine-family registry.
--
-- ONE ROW PER EXISTING stt_engine KEY, read from the migrations that seeded them (0018, 0022,
-- 0026, 0027) rather than from memory. The composites are the whole point: `elevenlabs_scribe`
-- is ElevenLabs ASR wearing Even's note generator, and `indicconformer_scribe` likewise, so both
-- carry their ASR's family. Scoring either against a window the other transcribed would be an
-- engine grading its own homework.
--
-- NO FK TO stt_engine. An engine row can be retired from the registry — 0023 already disabled
-- ekascribe — without erasing the family fact needed to refuse scores taken while it ran.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_engine_family (
  engine_key text PRIMARY KEY,
  family     text NOT NULL
);

COMMENT ON TABLE stt_engine_family IS
  'engine_key → family. Makes "an engine is never scored against a window its own family transcribed" a JOIN rather than a string compare, so a composite engine cannot score against its own ASR''s output.';

INSERT INTO stt_engine_family (engine_key, family) VALUES
  ('deepgram',              'deepgram'),
  ('whisper',               'whisper'),
  ('sarvam',                'sarvam'),
  ('elevenlabs',            'elevenlabs'),
  ('elevenlabs_scribe',     'elevenlabs'),      -- composite: ElevenLabs ASR + Even note LLM (0026)
  ('ekascribe',             'ekascribe'),       -- disabled by 0023; the row stays, the family fact outlives it
  ('indicconformer',        'indicconformer'),
  ('indicconformer_scribe', 'indicconformer'),  -- composite: IndicConformer ASR + Even note LLM (0027)
  ('even_pipeline',         'even'),            -- FLAGGED: see the comment below
  ('gemini',                'google')           -- RESERVED for Build 3; see the comment below
ON CONFLICT (engine_key) DO NOTHING;

-- even_pipeline IS FLAGGED, NOT CONFIDENTLY CLASSIFIED. It is a VIRTUAL scribe arm
-- (0022: `{"virtual":true,"source":"encounter.note_json"}`) with no ASR of its own — its
-- underlying transcript is whatever engine produced that encounter, so its true family VARIES
-- PER ROW and no static registry entry can be correct for it. 'even' names the pipeline that
-- assembled it, which is the only thing that is true of every such row. It is a note-tier arm on
-- the encounter path and never competes for a room-window gold, so the contamination rule never
-- consults it in practice — but if it ever does, this row is a guess and must be revisited.
--
-- gemini IS A RESERVATION, seeded ahead of the engine it names. Build 3 inserts the stt_engine
-- row; the family row is here because a MISSING family is the dangerous case (see the scorer:
-- an unregistered engine fails CLOSED and refuses, so an omission would silently block scoring
-- rather than silently permit it). If Build 3 names the key anything other than 'gemini', it
-- must update this row rather than add a second one.

-- ---------------------------------------------------------------------
-- 3. Room gold.
--
-- seed_engine_family SURVIVES GRADUATION. That is the load-bearing sentence of §4 and the reason
-- the column is not cleared when status becomes 'graduated': a human re-listening to a Sarvam
-- transcript is still reading Sarvam's words before writing their own, so the contamination is
-- not removed by the re-listen — only bounded by it. An engine of that family is refused for the
-- life of the row.
--
-- covered_ms AND window_ms ARE BOTH STORED even though the window's own length is derivable from
-- bench_window. A gold reference covers as much of the window as the labeller actually
-- transcribed, and the coverage floor (60%) is a statement about the REFERENCE, not the tape.
-- Deriving window_ms at read time would silently change every historic coverage ratio the day a
-- window's bounds were ever corrected.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_gold_window (
  window_id          text PRIMARY KEY REFERENCES bench_window(id) ON DELETE CASCADE,
  reference_text     text NOT NULL,
  source             text,
  seed_engine_family text,
  produced_by        text,
  verified_by        text,
  verified_at        timestamptz,
  status             text NOT NULL,
  covered_ms         int,
  window_ms          int,
  silence_spans_json jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stt_gold_window_source_chk
    CHECK (source IS NULL OR source IN ('human_verbatim', 'contaminated_seed', 'machine_assisted')),
  CONSTRAINT stt_gold_window_status_chk
    CHECK (status IN ('seed', 'in_review', 'graduated', 'rejected'))
);

COMMENT ON TABLE stt_gold_window IS
  'Reference transcripts keyed on bench_window.id. Separate from stt_gold, whose PK IS encounter_id with an FK to encounter — which is why a room window could never be a gold subject there.';
COMMENT ON COLUMN stt_gold_window.seed_engine_family IS
  'The family whose output seeded this reference. SURVIVES GRADUATION: a human re-listening to a machine transcript reads its words first, so graduation bounds the contamination rather than removing it.';
COMMENT ON COLUMN stt_gold_window.silence_spans_json IS
  'Typed silence spans [{start_ms, end_ms, type}] with type in (equipment | corridor | ambient). NULL means nobody has typed them, which refuses insertions_per_silent_second as SILENCE_UNTYPED while leaving WER computable.';
COMMENT ON COLUMN stt_gold_window.status IS
  'seed | in_review | graduated | rejected. Only ''graduated'' is scoreable. Graduation = blind independent re-listen, diff, adjudication — the tooling for which is deliberately NOT in Build 2.';

CREATE INDEX IF NOT EXISTS idx_stt_gold_window_status ON stt_gold_window (status);

-- ---------------------------------------------------------------------
-- 4. Refusals.
--
-- The closed vocabulary, enforced by CHECK so a fifth reason is a migration rather than a typo.
--
-- THE UNIQUE INDEX IS AN ADDITION TO THE SPEC'D SHAPE AND IS FLAGGED. The spec names the columns
-- but no constraint beyond the PK, and the scorer is meant to be re-runnable. Without a
-- uniqueness rule a nightly re-score writes one more identical refusal row per pair per night
-- for ever, and `n_refused` — the number the leaderboard is forbidden to publish WER without —
-- would grow while nothing changed. The surrogate id is kept exactly as specified.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_score_refusal (
  id          text PRIMARY KEY,
  window_id   text NOT NULL,
  engine_key  text NOT NULL,
  reason_code text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stt_score_refusal_reason_chk
    CHECK (reason_code IN (
      'NO_RECEIPT', 'LEGACY_UNRECEIPTED', 'NO_GOLD', 'GOLD_NOT_GRADUATED',
      'FAMILY_CONTAMINATION', 'COVERAGE_BELOW_FLOOR', 'SILENCE_UNTYPED'
    ))
);

COMMENT ON TABLE stt_score_refusal IS
  'One row per (window, engine) pair the scorer declined, with a closed-set reason. PRD §4: no code path renders WER without its refusal rate.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_stt_score_refusal_pair
  ON stt_score_refusal (window_id, engine_key, reason_code);
CREATE INDEX IF NOT EXISTS idx_stt_score_refusal_reason
  ON stt_score_refusal (reason_code, created_at DESC);

-- ---------------------------------------------------------------------
-- 5. The five Cardiology windows enter as contaminated seeds.
--
-- KEYED ON THE NATURAL KEY, NOT ON A CONSTRUCTED ID. `uq_bench_window_span` makes
-- (session_id, start_ms, end_ms, source_mic) the true identity of a window; the `bw_…` id string
-- is a convention this migration deliberately does not reproduce, because guessing an id format
-- is how a seed silently lands on nothing. The five start_ms values below are 24 Aug 2026
-- 12:00–13:15 IST at fifteen-minute spacing, and the last of them (1787556600000) is the window
-- the grounding document names in full as bw_z3gpbh6e_1787556600000_primary — so the shape is
-- corroborated against a known-real row rather than assumed.
--
-- IF THE RUNS ARE NOT THERE, THIS INSERTS NOTHING. Every guard below is a WHERE clause, so a
-- missing or errored run yields zero rows rather than a gold reference made of NULL. status is
-- 'seed' and NOT 'graduated': these are Sarvam's own words, and PRD §1.4 is explicit that
-- graduation needs a blind human re-listen. Until then every pair that names them refuses.
-- ---------------------------------------------------------------------
INSERT INTO stt_gold_window
  (window_id, reference_text, source, seed_engine_family, produced_by, status,
   covered_ms, window_ms, silence_spans_json, created_at)
SELECT w.id,
       r.transcript_original,
       'contaminated_seed',
       'sarvam',
       'sarvam:' || r.id,
       'seed',
       900000,
       900000,
       NULL,
       now()
  FROM bench_window w
  JOIN transcription_run r
    ON r.subject_type = 'bench_window'
   AND r.subject_id = w.id
 WHERE w.session_id = 'bs_z3gpbh6e'
   AND w.source_mic = 'primary'
   AND w.start_ms IN (1787553000000, 1787553900000, 1787554800000, 1787555700000, 1787556600000)
   AND r.engine = 'sarvam'
   AND r.error IS NULL
   AND r.transcript_original IS NOT NULL
   AND length(btrim(r.transcript_original)) > 0
ON CONFLICT (window_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 6. Grants — saying no out loud.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc') THEN
    -- brain_svc reads cue, room_day, visit, speaker_cluster and room. The evidence spine is the
    -- STT layer's own bookkeeping and the brain neither reads nor writes it, so nothing is
    -- granted. Recorded rather than left to be inferred from silence (0053, 0066, 0071).
    RAISE NOTICE '0072: brain_svc exists and is deliberately granted nothing on stt_engine_family, stt_gold_window or stt_score_refusal';
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (72, '0072_evidence_spine')
ON CONFLICT DO NOTHING;
