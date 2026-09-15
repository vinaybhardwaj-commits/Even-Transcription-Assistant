-- =====================================================================
-- Migration 0097 — E16: an emotion score records how much of its span was this speaker speaking.
--
-- WHY. A span that passed the service's gate was scored as if it were all speech, and nothing on the
-- row said otherwise: chunk A9 got `neutral` over 29 s holding 2.28 s of its speaker's speech
-- (ETA-E14-ROOTCAUSE, ETA-E16-REPORT §2). A label a reader cannot weigh is worse than no label.
--
--   speech_ms           the diarizer's speech attributed to THIS row's speaker inside the span, in ms
--                       (union of room_diarize_window.segments_json intervals for speaker_idx, clipped
--                       to [clip_start_s, clip_end_s]). The semantic measure: how much of this span was
--                       this person speaking. Fraction = speech_ms / ((clip_end_s - clip_start_s) * 1000).
--   service_speech_ms   the emotion service's own `speech_s_est` × 1000, where it returns one — today
--                       only on an unscorable answer. The operational measure: why the gate refused.
--                       Kept beside speech_ms because the two measure different things and diverge.
--   speech_basis        where speech_ms came from. Existing rows AND any row written by code that
--                       predates E16 take the DEFAULT 'pre_speech_fraction', so a pre-fix score can
--                       never be read as a post-fix one — including rows written between this
--                       migration and the deploy. E16 code writes 'diarize_segments' only beside a speech_ms
--                       it measured (CHECK room_span_emotion_basis_measure_chk).
--                       'service_speech_est' is RESERVED for the service-contract round (option D),
--                       unwritten today; declared now so that round needs no second CHECK change.
--
--   state 'unscorable'  a span with too little of its speaker's speech to score: either never sent
--                       (diarized speech under the service's min_speech_s, read from /health) or sent and
--                       refused by the service's gate. Neither is a failure and neither counts toward
--                       a window's zero-scored rule (lib/emotion/store.ts).
--   segments_unscorable the window's count of those rows, counted from the rows like the others.
--
-- NO CUTOFF IS STORED OR APPLIED. The floor below which a label should not be shown is set later,
-- from a clinic week of speech_ms (ETA-E16-RULING §2).
--
-- =====================================================================
-- ⚠  ROLLBACK HAZARD — READ BEFORE RESTORING ANY app.py BACKUP ON THE MINI  ⚠
--
-- **E16 code requires the emotion service's /health to report `min_speech_s`.** ALL FIVE
-- `~/eta-emotion/app.py.bak-*` files predate it. **Restoring any of them after E16 deploys makes EVERY
-- emotion window fail `health_min_speech_unreadable` and spend an attempt — windows exhaust in three
-- ticks where pre-E16 code would have scored.** A plain RESTART is safe: health() returns min_speech_s
-- whether or not the model is loaded. Roll the APP back to pre-E16 before, or together with, rolling the
-- service back to a backup. This migration itself is safe under either version of the app (the DEFAULT).
-- =====================================================================
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; every constraint is dropped-if-exists and re-added, or
-- guarded by name. Existing rows are untouched except for the DEFAULT on speech_basis.
-- GRANTS: none. Both tables are app-owned (0089).
-- =====================================================================

ALTER TABLE room_span_emotion ADD COLUMN IF NOT EXISTS speech_ms integer NULL;
ALTER TABLE room_span_emotion ADD COLUMN IF NOT EXISTS service_speech_ms integer NULL;
ALTER TABLE room_span_emotion ADD COLUMN IF NOT EXISTS speech_basis text NOT NULL DEFAULT 'pre_speech_fraction';

ALTER TABLE room_span_emotion DROP CONSTRAINT IF EXISTS room_span_emotion_speech_basis_chk;
ALTER TABLE room_span_emotion ADD CONSTRAINT room_span_emotion_speech_basis_chk
  CHECK (speech_basis IN ('pre_speech_fraction', 'diarize_segments', 'service_speech_est'));

-- E16(iii): a row that says its speech came from the diarizer must carry that speech.
ALTER TABLE room_span_emotion DROP CONSTRAINT IF EXISTS room_span_emotion_basis_measure_chk;
ALTER TABLE room_span_emotion ADD CONSTRAINT room_span_emotion_basis_measure_chk
  CHECK (speech_basis <> 'diarize_segments' OR speech_ms IS NOT NULL);

ALTER TABLE room_span_emotion DROP CONSTRAINT IF EXISTS room_span_emotion_speech_ms_chk;
ALTER TABLE room_span_emotion ADD CONSTRAINT room_span_emotion_speech_ms_chk
  CHECK ((speech_ms IS NULL OR speech_ms >= 0) AND (service_speech_ms IS NULL OR service_speech_ms >= 0));

ALTER TABLE room_span_emotion DROP CONSTRAINT IF EXISTS room_span_emotion_state_chk;
ALTER TABLE room_span_emotion ADD CONSTRAINT room_span_emotion_state_chk
  CHECK (state IN ('scored', 'skipped', 'failed', 'unscorable'));

ALTER TABLE room_emotion_window ADD COLUMN IF NOT EXISTS segments_unscorable integer NULL;

COMMENT ON COLUMN room_span_emotion.speech_ms IS
  'E16: the diarizer''s speech for this row''s speaker inside the span, ms (union of segments_json intervals, clipped). NULL on pre-E16 rows. No cutoff is applied to it.';
COMMENT ON COLUMN room_span_emotion.service_speech_ms IS
  'E16: the emotion service''s speech_s_est x 1000 where it returned one (today: unscorable answers only). The gate''s measure, not the speaker''s.';
COMMENT ON COLUMN room_span_emotion.speech_basis IS
  'E16: pre_speech_fraction (DEFAULT: every row scored without a speech measure) | diarize_segments (E16) | service_speech_est (RESERVED for the service-contract round, unwritten).';
COMMENT ON COLUMN room_span_emotion.state IS
  'scored | skipped | failed | unscorable (CHECK). unscorable (0097): too little of the speaker''s speech — never sent, or refused by the service''s gate. Not a failure.';
COMMENT ON COLUMN room_emotion_window.segments_unscorable IS
  'E16: room_span_emotion rows in state unscorable for this window and diarize run, counted from the rows. NULL on pre-E16 windows.';

INSERT INTO schema_migrations (version, name)
VALUES (97, '0097_room_span_emotion_speech')
ON CONFLICT DO NOTHING;
