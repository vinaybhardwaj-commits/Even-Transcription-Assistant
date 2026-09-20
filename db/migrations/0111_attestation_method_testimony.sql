-- =====================================================================
-- Migration 0111 — room_clinician_attestation.method admits occupant testimony.
--
-- WHY (V's ruling, 19 Sep 2026). 0109 created the table with `method` CHECKed to ('pin') so that
-- nothing weaker than a verified PIN presentation could ever be written into it and read back as
-- attested. That was right, and it has one consequence: the CHEAPEST first attested clinician-day
-- available to us — a room's own occupant attesting their own day from memory — is refused by it.
-- The ruling is to admit that evidence and LABEL it, rather than keep the table pure and write the
-- binding somewhere it carries no grade at all.
--
-- TWO GRADES, NEVER CONFLATED. After this migration the column holds exactly two values:
--   'pin'                 a PIN was presented to the server and verified against the hash.
--   'occupant_testimony'  a person who was in the room said who was in the room. Strong, and still
--                         one person's memory. It is not a PIN and must never be counted as one.
-- Every reader that means "verified" filters `method = 'pin'`; a reader that means "we know who was
-- there, on someone's word" filters both. The grade travels with the row for ever.
--
-- ORDER DEPENDENCY, AND WHY THIS FAILS LOUDLY. 0109 is not merged into the branch this migration is
-- written against, so a run could reach 0111 with no table to alter. The guard below RAISES rather
-- than skipping: a migration that quietly does nothing and then records itself as applied is
-- precisely how a widening is lost for ever — the runner records by version with ON CONFLICT DO
-- NOTHING and would never revisit it. Promote 0109 and 0111 together, or this one stops the run and
-- says why.
--
-- ADDITIVE TO THE DATA. No row is rewritten; every existing row keeps method 'pin'. The constraint
-- is swapped, not the column.
-- =====================================================================

DO $$
BEGIN
  IF to_regclass('public.room_clinician_attestation') IS NULL THEN
    RAISE EXCEPTION
      '0111 requires 0109_room_clinician_attestation: the table does not exist. Promote 0109 with it.';
  END IF;
END $$;

ALTER TABLE room_clinician_attestation
  DROP CONSTRAINT IF EXISTS room_clinician_attestation_method_ck;

ALTER TABLE room_clinician_attestation
  ADD CONSTRAINT room_clinician_attestation_method_ck
  CHECK (method IN ('pin', 'occupant_testimony'));

COMMENT ON COLUMN room_clinician_attestation.method IS
  'How this binding was established. ''pin'' = presented to the server and verified against the hash. ''occupant_testimony'' = a person who was in the room said so — strong, but one person''s memory, and never to be counted as a verified PIN. Readers that mean "verified" filter on ''pin''.';

INSERT INTO schema_migrations (version, name)
VALUES (111, '0111_attestation_method_testimony')
ON CONFLICT DO NOTHING;
