-- =====================================================================
-- Migration 0085 — Tier 2 Slice C2: room_turn_speaker learns WHO, not just WHICH CLUSTER.
--
-- The table has carried `speaker_idx` since 0074 and nothing else about identity. An index is not
-- a person: it is the position of a cluster in a list the service sorts by total speaking time
-- (server.py:191), so idx 0 is merely the most talkative voice in the window. In a consultation
-- that is usually the doctor, which is exactly what makes it the tempting wrong answer.
--
-- These columns exist so a role can be recorded ONLY when it was actually established — by the
-- service's cosine match against an enrolled voiceprint — and so that a reader can tell the
-- difference between "this is Dr X" and "this is the voice that talked most".
--
-- THE CHECKS ARE THE RULE, IN THE SCHEMA, AND THEY RUN BOTH WAYS.
--   * role='clinician' REQUIRES a non-empty clinician_id and a match_confidence in [0,1];
--   * an identity REQUIRES the claim: clinician_id may be present only when role='clinician',
--     so no row can carry a name it does not assert — a name with no claim beside it is exactly
--     what a later reader would mistake for an attribution;
--   * match_confidence may be present only with that claim, and only as a real cosine.
--
-- A writer that inferred a clinician from speaker order has no id to put here and is rejected by
-- the database rather than accepted and believed. Attributing a patient's words to their doctor —
-- or the reverse — is worse than leaving the span unlabelled.
--
-- The first version of this migration stated the rule and enforced only half of it: an
-- 'unattributed' row carrying a clinician_id was accepted, as was a confidence of -5. Tightened
-- in place because 0085 has not been applied anywhere.
--
-- Additive and idempotent; no backfill, because there is nothing to backfill (the table is empty).
-- =====================================================================

ALTER TABLE room_turn_speaker
  ADD COLUMN IF NOT EXISTS clinician_id     text,
  ADD COLUMN IF NOT EXISTS role             text,
  ADD COLUMN IF NOT EXISTS match_confidence double precision,
  -- WHY a span has no name. Two of these are STRUCTURAL and permanent — 'straddle' (two speakers
  -- held this turn) and 'seam' (it crosses a slice boundary, so it belongs to two clusterings).
  -- 'no_match' is merely unresolved: nobody was recognised THIS time. Without the distinction the
  -- cross-slice stitch cannot tell them apart, and it filled all three alike, putting a straddled
  -- turn's other speaker back on the record as the clinician one step after the slice refused it.
  ADD COLUMN IF NOT EXISTS no_role_reason   text;

-- `role` is a closed vocabulary. 'clinician' is the only value that asserts an identity; every
-- other value describes what the service could tell WITHOUT one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_role_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_role_ck
      CHECK (role IS NULL OR role = 'clinician');
  END IF;
END $$;

-- A clinician role REQUIRES an id and a confidence. This is the rule that cannot be commented out.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_clinician_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_clinician_ck
      CHECK (role <> 'clinician' OR (clinician_id IS NOT NULL AND btrim(clinician_id) <> '' AND match_confidence IS NOT NULL));
  END IF;
END $$;

-- THE CONVERSE. An identity may exist only where it is claimed, and a confidence only where there
-- is something for it to be the confidence OF.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_identity_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_identity_ck
      CHECK ((clinician_id IS NULL AND match_confidence IS NULL) OR role = 'clinician');
  END IF;
END $$;

-- A ROW EITHER CLAIMS A NAME OR SAYS WHY IT DOES NOT. Exactly one of the two, never both, never
-- neither — so no row can be silently unattributed for a reason nobody recorded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_no_role_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_no_role_ck
      CHECK ((role IS NULL) = (no_role_reason IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_reason_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_reason_ck
      CHECK (no_role_reason IS NULL OR no_role_reason IN ('straddle', 'seam', 'no_match'));
  END IF;
END $$;

-- A cosine is a number in [0,1]. -5 is not a weak match; it is a bug that reached the table.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_confidence_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_confidence_ck
      CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_room_turn_speaker_clinician
  ON room_turn_speaker (clinician_id) WHERE clinician_id IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (85, '0085_room_turn_speaker_role')
ON CONFLICT DO NOTHING;
