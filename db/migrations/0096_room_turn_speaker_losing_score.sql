-- =====================================================================
-- Migration 0096 — E20: an unnamed room turn records the score that lost.
--
-- WHY. 151 turns reached the matcher and were not named, and match_confidence is NULL on every one, so
-- nothing can say whether they missed by 0.02 or by 0.30 — which is exactly the number the three
-- unratified thresholds (0.65 room, 0.70 encounter, 0.78 phone) need (ETA-E1-RULINGS R-F3b). The diarize
-- service computes that best candidate and discards it before responding (server.py:186-216); E20 recomputes
-- it in the app from the embeddings the service does return (lib/stt/losing-score.ts), under a control.
--
-- NEW COLUMNS, NOT match_confidence / clinician_id. Those mean "the name we assigned, and its confidence":
-- NULL there means unnamed, and 0085's room_turn_speaker_identity_ck allows them only where role =
-- 'clinician'. A losing value in them would make every existing reader of match_confidence ambiguous, and
-- the schema already forbids it. So the losing candidate has columns whose names say what it is:
--
--   losing_clinician_id  the best candidate that did NOT clear the threshold (after the service's greedy
--                        exclusion of clinicians assigned to louder speakers in the same window).
--   losing_score         its cosine, in [0,1]. Below the threshold by construction; NOT a confidence.
--   score_basis          where losing_score came from:
--                          'app_recomputed'    E20: recomputed in the app from the service's embeddings.
--                          'service_reported'  RESERVED for the option-2 round (the service returning the
--                                              losing candidate itself). UNWRITTEN today; declared now so
--                                              that round needs no second CHECK change.
--
-- THE CHECKS ARE THE RULE, IN THE SCHEMA.
--   * a losing candidate exists ONLY on an unnamed no_match row: never beside a name, never on a straddle
--     (a straddled turn never reached the matcher as one speaker);
--   * the three columns travel together: all set or all NULL;
--   * losing_score is a cosine in [0,1]; score_basis is a closed vocabulary.
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS, no DEFAULT, no backfill: every existing row keeps
-- NULL in all three, which every CHECK here accepts, and no existing column changes meaning. Constraints
-- are guarded by name, as 0085's are. GRANTS: none; the table is app-owned.
-- =====================================================================

ALTER TABLE room_turn_speaker
  ADD COLUMN IF NOT EXISTS losing_clinician_id text,
  ADD COLUMN IF NOT EXISTS losing_score        double precision,
  ADD COLUMN IF NOT EXISTS score_basis         text;

-- Only an unnamed, unresolved turn has a losing candidate.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_losing_only_no_match_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_losing_only_no_match_ck
      -- COALESCE, as 0085 learned: a bare comparison is NULL for a NULL reason and a CHECK passes on NULL.
      CHECK ((losing_clinician_id IS NULL AND losing_score IS NULL AND score_basis IS NULL)
             OR (role IS NULL AND COALESCE(no_role_reason, '') = 'no_match'));
  END IF;
END $$;

-- All three, or none: a score with no clinician, or either with no basis, is not a record anyone can read.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_losing_together_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_losing_together_ck
      CHECK ((losing_clinician_id IS NULL) = (losing_score IS NULL)
         AND (losing_score IS NULL) = (score_basis IS NULL)
         AND (losing_clinician_id IS NULL OR btrim(losing_clinician_id) <> ''));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_losing_score_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_losing_score_ck
      CHECK (losing_score IS NULL OR (losing_score >= 0 AND losing_score <= 1));
  END IF;
END $$;

-- 'service_reported' is RESERVED for the option-2 round and unwritten today.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_score_basis_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_score_basis_ck
      CHECK (score_basis IS NULL OR score_basis IN ('app_recomputed', 'service_reported'));
  END IF;
END $$;

COMMENT ON COLUMN room_turn_speaker.losing_clinician_id IS
  'E20: on an unnamed no_match turn, the best candidate that did not clear the threshold (after the service''s greedy exclusion). NULL otherwise. Not an attribution.';
COMMENT ON COLUMN room_turn_speaker.losing_score IS
  'E20: that candidate''s cosine, [0,1], below the threshold. Not a confidence; match_confidence stays the named path''s alone.';
COMMENT ON COLUMN room_turn_speaker.score_basis IS
  'E20: app_recomputed (recomputed from the service''s embeddings, under a control) | service_reported (RESERVED for the option-2 round, unwritten).';

INSERT INTO schema_migrations (version, name)
VALUES (96, '0096_room_turn_speaker_losing_score')
ON CONFLICT DO NOTHING;
