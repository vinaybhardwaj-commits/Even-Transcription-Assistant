-- =====================================================================
-- Migration 0099 — E24 R9/R8: which diarize run wrote a window's segments, as a FACT.
--
-- !!! DEPLOY ORDER (E25 R16): 0099 MUST be applied before this code deploys. !!!
-- Reversed, every diarize INSERT and every emotion prepare SELECT fails on the missing column, and every emotion
-- window write fails on the missing stale_segments_run_id. See docs/handoff/ETA-E25-DEPLOY-ORDER-E24.md.
--
-- WHY. `recordDiarizeWindow` keeps an `ok` row's speakers_json and segments_json when a later diarize run
-- succeeds (lib/stt/diarize-window.ts, the keep-rule — unchanged here, by ruling R10), while last_run_id
-- advances and that run's turns are written. The emotion job used to INFER from one symptom (do the stored
-- turns still bind?) whether the intervals belonged to the run it was scoring. The Refuter showed three
-- disagreements that symptom cannot see (ETA-E16-REFUTATION §4 P1–P3).
--
--   room_diarize_window.segments_run_id   the run id that wrote segments_json (and speakers_json). It is
--                                         written on the same terms as segments_json, so the pair can never
--                                         disagree. The emotion job compares it with last_run_id.
--                                         NULL = NO WRITER RUN IS RECORDED: provenance UNKNOWN, and treated as
--                                         stale rather than guessed. NULL does not say the row predates this
--                                         migration: code older than E24 still writes NULL after 0099 lands
--                                         (E25 R17). NO BACKFILL in this migration — which run wrote an existing
--                                         row's segments is not recorded anywhere, and asserting last_run_id
--                                         would re-create the inference this column replaces.
--
--   room_emotion_window.state 'diarize_stale'
--                                         the window's segments belong to another diarize run (or to an
--                                         unknown one). TERMINAL and NOT A FAILURE: it spends no attempt,
--                                         and the enqueue scan offers the window again only when last_run_id
--                                         moves. Carries its reason in `error`.
--
--   room_emotion_window.stale_segments_run_id
--                                         on a diarize_stale row: the segments_run_id the stale decision was
--                                         made against (NULL when that was NULL). NULL on every other state
--                                         (CHECK). It scopes the repair to ONE use per stale mark (E25 R15).
--
-- THE CURE, made true by R10: a fresh diarize run on a window already recorded diarize_stale is accepted by
-- the named repair path `repairStaleDiarizeSegments` (lib/stt/diarize-window.ts), which replaces that
-- window's speakers_json + segments_json + segments_run_id. No other window is affected. It adopts content
-- only from a run that itself ended `ok` (E25 R13), and only while the stored segments are still the ones the
-- stale mark judged (E25 R15): once repaired, a further run before the window is rescored meets the keep-rule.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; constraints dropped-if-exists and re-added.
-- ORDER: requires 0074/0088/0090 (room_diarize_window) and 0089 (room_emotion_window). Independent of 0097.
-- GRANTS: none. Both tables are app-owned.
-- =====================================================================

ALTER TABLE room_diarize_window ADD COLUMN IF NOT EXISTS segments_run_id text NULL;

ALTER TABLE room_emotion_window DROP CONSTRAINT IF EXISTS room_emotion_window_state_chk;
ALTER TABLE room_emotion_window ADD CONSTRAINT room_emotion_window_state_chk
  CHECK (state IN ('ok', 'failed', 'no_segments', 'diarize_stale'));

-- A diarize_stale row names its reason, as a failed row does.
ALTER TABLE room_emotion_window DROP CONSTRAINT IF EXISTS room_emotion_window_error_chk;
ALTER TABLE room_emotion_window ADD CONSTRAINT room_emotion_window_error_chk
  CHECK ((state IN ('failed', 'diarize_stale')) = (error IS NOT NULL));

-- E25 R15: the segments a stale mark judged. Only a diarize_stale row carries one.
ALTER TABLE room_emotion_window ADD COLUMN IF NOT EXISTS stale_segments_run_id text NULL;
ALTER TABLE room_emotion_window DROP CONSTRAINT IF EXISTS room_emotion_window_stale_segments_chk;
ALTER TABLE room_emotion_window ADD CONSTRAINT room_emotion_window_stale_segments_chk
  CHECK (stale_segments_run_id IS NULL OR state = 'diarize_stale');

COMMENT ON COLUMN room_diarize_window.segments_run_id IS
  'E24 (0099): the diarize run that wrote segments_json and speakers_json. Written on the same terms as segments_json. NULL = no writer run is recorded, provenance unknown (treated as stale by the emotion job).';
COMMENT ON COLUMN room_emotion_window.stale_segments_run_id IS
  'E25 R15 (0099): on a diarize_stale row, the segments_run_id the stale decision was made against. The repair acts only while room_diarize_window.segments_run_id still equals it, so one stale mark permits one repair. NULL on every other state (CHECK).';
COMMENT ON COLUMN room_emotion_window.state IS
  'ok | failed | no_segments | diarize_stale (CHECK). diarize_stale (0099): segments_run_id is not last_run_id — terminal, not a failure, no attempt spent; repaired by the next diarize run (repairStaleDiarizeSegments).';

INSERT INTO schema_migrations (version, name)
VALUES (99, '0099_room_diarize_segments_run_id')
ON CONFLICT DO NOTHING;
