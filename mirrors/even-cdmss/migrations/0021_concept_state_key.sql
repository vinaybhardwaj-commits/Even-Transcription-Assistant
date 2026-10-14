-- 0021_concept_state_key.sql — Concept Coder correctness fix (CDMSS-CONCEPT-CODER kickoff, 26 Jul).
-- Applied by hand via POST /api/admin/migrate-concept-state-key. Idempotent.
--
-- ⚠️ APPLY ONLY WITH THE WORKER PAUSED (even_concept_paused='1'). This swaps a primary key on a table
-- a 2-minute cron writes to; a PK swap under a live writer is the one irreversible failure mode here.
--
-- DEFECT A — the watermark was keyed on `uid` alone while opd_note_audits is keyed on
-- (uid, engine_version). One watermark row could therefore certify only one engine row, and the
-- candidate predicate then excluded every other engine row for that uid permanently. Measured before
-- this migration: 256 in-family low-value findings across 201 uids, unreachable under epoch 1.
--
-- DEFECT B — no engine-family provenance on coded AUDIT ROWS, so nothing downstream can separate
-- in-family rows (which user surfaces read) from legacy-engine ones (which none do). GRAIN MATTERS:
-- measured 26 Jul the out-of-family share was ~30% by AUDIT ROW (3,535 of 11,760) but ~22% by NOTE,
-- because a note re-audited under several engine versions is several rows. Quote the right one.
-- in_family backfills as the corrected join re-walks each row, NOT at migration time.
--
-- DEFECT C — lvc_concepts.volume is the research team's SEED measurement and is deliberately
-- preserved (it has evidential value and predicted the live distribution well). live_volume is a new,
-- separate column recomputed in bulk from coded findings on in-family rows only.

-- ── even_concept_state: re-key on (uid, engine_version) ───────────────────────
ALTER TABLE even_concept_state ADD COLUMN IF NOT EXISTS engine_version TEXT;
ALTER TABLE even_concept_state ADD COLUMN IF NOT EXISTS in_family BOOLEAN;

-- Existing rows predate the key and cannot be attributed to one engine version. Stamp an explicit
-- SENTINEL, never NULL: Postgres treats NULLs as distinct in a unique index, so a NULL here would
-- silently permit duplicate (uid, NULL) rows and reintroduce the very defect being fixed.
UPDATE even_concept_state SET engine_version = 'epoch1-unkeyed' WHERE engine_version IS NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='even_concept_state' AND column_name='engine_version' AND is_nullable='YES') THEN
    ALTER TABLE even_concept_state ALTER COLUMN engine_version SET NOT NULL;
  END IF;
END $$;

-- Drop the uid-only PK (whatever it is named) and replace it with the composite unique key.
DO $$
DECLARE pk_name TEXT;
BEGIN
  SELECT c.conname INTO pk_name
  FROM pg_constraint c
  WHERE c.conrelid = 'even_concept_state'::regclass AND c.contype = 'p'
    AND (SELECT count(*) FROM unnest(c.conkey)) = 1;
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE even_concept_state DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS even_concept_state_uid_engine_uidx
  ON even_concept_state (uid, engine_version);

CREATE INDEX IF NOT EXISTS even_concept_state_in_family_idx ON even_concept_state (in_family);

-- ── lvc_concepts: live_volume alongside the preserved seed `volume` ───────────
ALTER TABLE lvc_concepts ADD COLUMN IF NOT EXISTS live_volume INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS lvc_concepts_live_lane_idx ON lvc_concepts (review_lane, live_volume DESC);
