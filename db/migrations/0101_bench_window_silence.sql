-- =====================================================================
-- Migration 0101 — E18: silence is a NAMED state that carries its evidence and can be re-adjudicated.
--
-- !!! DEPLOY ORDER: 0101 MUST be applied before this code deploys. !!!
-- Reversed, every silent window's finish fails on the state CHECK ('silent' is refused) and every silence
-- verdict write fails on a missing table. E25's proof of this class is tests/unit/e25-deploy-order.test.ts on
-- the E16 branch; the same rule holds here.
--
-- WHY. E11 made a silent window cost no attempt and never be offered again, which is right and does not change
-- here. What was wrong is that the verdict was UNEVIDENCED and UNREVISITABLE while E13 (a dead mic cannot be
-- told from a quiet room) and E15 (VAD calibration, UNVERIFIED) are both open. A false negative we cannot
-- re-examine is audio we have thrown away.
--
--   bench_window.state 'silent'    "we heard nothing" is not "we heard something". A silent window is settled
--                                  and is NOT `transcribed`: no reader can any longer count the two as one.
--
--   bench_window_silence           one row per window, written AT THE MOMENT THE VERDICT IS MADE, holding what
--                                  the verdict was made from. Its nullable columns are nullable because the
--                                  facts are genuinely absent today, and each absence is NAMED rather than
--                                  guessed:
--                                    audio_level_source = 'absent'     the recorder sent no level. This is the
--                                      EXPECTED value: the native recorder has never sent one (0 of 4,405
--                                      chunks). bench_chunk.peak_level/avg_level (0066) is where it would be.
--                                    vad_params_source  = 'unreported' the whisper service does not report the
--                                      flags it ran under (--vad, --no-speech-thold, --suppress-nst, the Silero
--                                      version). Nothing in this repo can observe them, so they are stored NULL
--                                      and SAID to be unreported. When the service starts reporting them, the
--                                      columns are already here and the source becomes 'service'.
--                                  A verdict we cannot re-derive is a verdict we cannot overturn; this row says
--                                  exactly how far the current verdict can be re-derived, and no further.
--
--   reopened_at / reopened_batch / reopened_reason / reopened_detector
--                                  the re-adjudication ledger. `reopenSilentWindows` (lib/stt/silence.ts) moves
--                                  a whole matching set back to 'closed' in ONE statement and stamps these, so
--                                  the population that was re-run is itself queryable afterwards. Per-window
--                                  `force` is not a bulk mechanism and is not the answer to E13/E15's backlog.
--                                  reopened_detector NAMES WHICH DETECTOR re-ran the set (E25 R31.3). Without it,
--                                  a second pass with a better detector is indistinguishable from the first, and
--                                  the fact that one verdict overwrote another is lost with it.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not adjudicate anything. It does not detect a dead mic (E13) and it
-- does not calibrate VAD (E15). It records what was decided and keeps the audio reachable for the detector that
-- lands later.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS; the state CHECK is dropped-if-exists and re-added.
-- ORDER: requires 0057 (bench_window) and 0066 (bench_chunk levels). Independent of 0097/0099/0100.
-- GRANTS: none. bench_window and bench_window_silence are app-owned.
-- =====================================================================

ALTER TABLE bench_window DROP CONSTRAINT IF EXISTS bench_window_state_chk;
ALTER TABLE bench_window ADD CONSTRAINT bench_window_state_chk
  CHECK (state IN ('open','closed','transcribing','transcribed','failed','silent'));

-- The queryable set (R1.3). Partial: the resting states are not polled, but THIS one is re-adjudicated in bulk.
CREATE INDEX IF NOT EXISTS idx_bench_window_silent
  ON bench_window (state, closed_at) WHERE state = 'silent';

CREATE TABLE IF NOT EXISTS bench_window_silence (
  window_id          TEXT PRIMARY KEY REFERENCES bench_window(id) ON DELETE CASCADE,
  room_day_id        TEXT,
  session_id         TEXT,
  decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- HOW silence was concluded. One value today: the engine read the window and returned no speech.
  -- NULLABLE because a row can also be LEDGER-ONLY (R38): a window re-adjudicated before 0101 existed, or one
  -- whose verdict was written by code older than E18, still gets a row saying it was handed back and by whom.
  -- The row-kind CHECK below is what stops a row that is neither a verdict nor a ledger entry.
  verdict            TEXT,
  engine             TEXT,
  engine_version     TEXT,
  audio_seconds      DOUBLE PRECISION,
  -- The recorder's own meter, read off this window's chunks at verdict time (0066).
  audio_level_source TEXT,
  peak_level         REAL,
  avg_level          REAL,
  level_chunks       INTEGER NOT NULL DEFAULT 0,
  total_chunks       INTEGER NOT NULL DEFAULT 0,
  -- The whisper parameters in force, when the service reports them. It does not today.
  vad_params_source  TEXT,
  vad_enabled        BOOLEAN,
  no_speech_thold    DOUBLE PRECISION,
  suppress_nst       BOOLEAN,
  silero_version     TEXT,
  -- Everything else the answer carried, verbatim, so a later reader is not limited to the columns above.
  answer_json        JSONB,
  reopened_at        TIMESTAMPTZ,
  reopened_batch     TEXT,
  reopened_reason    TEXT,
  reopened_detector  TEXT,
  -- R39 — EVERY PASS, NOT THE LATEST ONE. The scalars above are the most recent re-adjudication, kept for a
  -- cheap read; this is the whole sequence, appended to and never overwritten. A detector that replaced its
  -- predecessor destroyed the evidence that the window had been re-adjudicated at all, which is the one thing
  -- the ledger exists to record. One object per pass: {at, batch, reason, detector}.
  reopened_history   JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT bench_window_silence_level_src_chk
    CHECK (audio_level_source IN ('recorder','absent')),
  -- A level and its source cannot disagree: 'absent' means no number, 'recorder' means a number.
  CONSTRAINT bench_window_silence_level_chk
    CHECK ((audio_level_source = 'recorder') = (peak_level IS NOT NULL OR avg_level IS NOT NULL)),
  CONSTRAINT bench_window_silence_vad_src_chk
    CHECK (vad_params_source IN ('service','unreported')),
  -- 'unreported' may not carry a parameter: an invented parameter is worse than a missing one.
  CONSTRAINT bench_window_silence_vad_chk
    CHECK (vad_params_source = 'service'
           OR (vad_enabled IS NULL AND no_speech_thold IS NULL AND suppress_nst IS NULL AND silero_version IS NULL)),
  CONSTRAINT bench_window_silence_reopen_chk
    CHECK ((reopened_at IS NULL) = (reopened_batch IS NULL)),
  -- A re-adjudication that cannot say WHICH detector ran is not a re-adjudication anybody can repeat or compare.
  CONSTRAINT bench_window_silence_detector_chk
    CHECK ((reopened_at IS NULL) = (reopened_detector IS NULL)),
  -- A row is a VERDICT (all four evidence columns present) or a LEDGER ENTRY (it was handed back), or both.
  -- Neither is a row nobody wrote for a reason.
  CONSTRAINT bench_window_silence_row_kind_chk
    CHECK ((verdict IS NOT NULL AND engine IS NOT NULL AND audio_level_source IS NOT NULL AND vad_params_source IS NOT NULL)
           OR reopened_at IS NOT NULL),
  -- The history holds one object per pass, and it cannot be emptier than the scalars claim.
  CONSTRAINT bench_window_silence_history_chk
    CHECK (jsonb_typeof(reopened_history) = 'array'
           AND (reopened_at IS NULL OR jsonb_array_length(reopened_history) >= 1))
);

-- The set E13/E15 will re-run: verdicts nobody has re-adjudicated yet, oldest first.
CREATE INDEX IF NOT EXISTS idx_bench_window_silence_pending
  ON bench_window_silence (decided_at) WHERE reopened_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bench_window_silence_batch
  ON bench_window_silence (reopened_batch) WHERE reopened_batch IS NOT NULL;

COMMENT ON TABLE bench_window_silence IS
  'E18 (0101): one row per window called silent, written when the verdict is made. Holds what the verdict was made from, including what was NOT available: audio_level_source=absent (the recorder sent no level) and vad_params_source=unreported (the whisper service does not report its VAD flags). Re-adjudicated in bulk by reopenSilentWindows (lib/stt/silence.ts).';
COMMENT ON COLUMN bench_window_silence.audio_level_source IS
  'recorder = at least one of this window''s chunks carried a meter reading (0066). absent = none did, which is the expected value: the native recorder has never sent one (0 of 4,405 chunks on 16 Sep 2026).';
COMMENT ON COLUMN bench_window_silence.reopened_history IS
  'E25 R39 (0101): every re-adjudication this window has had, appended in order — {at, batch, reason, detector} per pass. The reopened_* scalars are the latest pass; this is all of them, because a second detector replacing the first destroys the fact that the window was re-adjudicated before.';
COMMENT ON COLUMN bench_window_silence.reopened_detector IS
  'E25 R31.3 (0101): which detector re-adjudicated this window, named by the caller of the bulk path. A second pass with a better detector must be distinguishable from the first.';
COMMENT ON COLUMN bench_window_silence.vad_params_source IS
  'unreported = the whisper service does not report the flags it ran under, so --vad, --no-speech-thold, --suppress-nst and the Silero version are stored NULL rather than assumed. service = the answer carried them.';
COMMENT ON COLUMN bench_window.state IS
  'open | closed | transcribing | transcribed | failed | silent (CHECK). silent (0101): the engine read the window and it held no speech. Settled, costs no attempt, and NEVER folded into transcribed — see bench_window_silence for the evidence.';

INSERT INTO schema_migrations (version, name)
VALUES (101, '0101_bench_window_silence')
ON CONFLICT DO NOTHING;
