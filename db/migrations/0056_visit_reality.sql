-- =====================================================================
-- Migration 0056 — visit gets an end, an attributed clinician, and a tape span
-- (22 Aug 2026). Seven nullable columns, two CHECKs, one partial index.
-- Additive and idempotent. NOTHING IN THIS BUILD WRITES ANY OF THESE COLUMNS.
--
-- WHAT THE COLUMNS ARE FOR
--   ended_at              a visit's own end, distinct from `end_reason` (which
--                         already says WHY, but never WHEN).
--   clinician_id          WHO was in the room for THIS visit.
--   clinician_source      HOW we came to believe that, from a closed set.
--   clinician_confidence  how strongly, REAL, nullable — unsure stays a
--                         first-class state here exactly as it is for `state`.
--   session_id            which bench tape the visit was heard on.
--   tape_start_ms         where the visit begins on that tape, epoch ms.
--   tape_end_ms           and where it ends.
--
-- ATTRIBUTION IS PER VISIT, NEVER PER ROOM-DAY. room_day.doctor_id stays dead
-- and is NOT revived here. Binding one room to one doctor for a whole day is
-- what lost six hours of another clinician's clinic on 19 August: the second
-- clinician's visits were all filed under the first, and there was no per-visit
-- row to disagree with the room-day. This column set is that disagreement,
-- made possible.
--
-- clinician_source IS A CLOSED SET, and 'unknown' is a LEGITIMATE TERMINAL
-- VALUE, not an error and not a placeholder for "fill this in later":
--   'roster'    the day's schedule said so
--   'voice'     a voiceprint match said so
--   'mark'      a consult_mark / operator_pin said so
--   'operator'  a human told us directly
--   'unknown'   we looked and we do not know
-- A visit that ends 'unknown' is correctly attributed — to nobody. That is a
-- better row than a guess, and the CHECK admits it as a first-class answer.
-- The CHECK also admits NULL: a row that was never attributed at all differs
-- from one attributed to 'unknown', and both must be sayable.
--
-- The span CHECK is deliberately one-sided-tolerant: it only fires when BOTH
-- ends are present, so a visit whose start is known and whose end is not is
-- legal, which is the state every open visit is in.
--
-- The index is PARTIAL (clinician_id IS NOT NULL) because every row today has
-- a NULL there and will for the whole of this build — a full index would be
-- entirely NULLs. No FK on clinician_id in this build: the fuse that will
-- write it has not run yet, and adding the reference is a later step taken
-- against real values.
--
-- NOT TOUCHED: visit's primary key, its `state` CHECK, arm/opened_by/
-- opened_by_kind (0048), ambiguity (0049), visit_arm_opened_by_key,
-- visit_room_day_idx, and room_day in every particular.
-- =====================================================================

ALTER TABLE visit ADD COLUMN IF NOT EXISTS ended_at             TIMESTAMPTZ;
ALTER TABLE visit ADD COLUMN IF NOT EXISTS clinician_id         TEXT;
ALTER TABLE visit ADD COLUMN IF NOT EXISTS clinician_source     TEXT;
ALTER TABLE visit ADD COLUMN IF NOT EXISTS clinician_confidence REAL;
ALTER TABLE visit ADD COLUMN IF NOT EXISTS session_id           TEXT;
ALTER TABLE visit ADD COLUMN IF NOT EXISTS tape_start_ms        BIGINT;
ALTER TABLE visit ADD COLUMN IF NOT EXISTS tape_end_ms          BIGINT;

-- ADD CONSTRAINT has no IF NOT EXISTS; the DO wrapper is what makes it idempotent.
DO $$ BEGIN
  ALTER TABLE visit
    ADD CONSTRAINT visit_clinician_source_chk
    CHECK (clinician_source IS NULL OR clinician_source IN
      ('roster','voice','mark','operator','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE visit
    ADD CONSTRAINT visit_tape_span_chk
    CHECK (tape_end_ms IS NULL OR tape_start_ms IS NULL
           OR tape_end_ms > tape_start_ms);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS visit_clinician_idx ON visit (clinician_id)
  WHERE clinician_id IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (56, '0056_visit_reality')
ON CONFLICT DO NOTHING;
