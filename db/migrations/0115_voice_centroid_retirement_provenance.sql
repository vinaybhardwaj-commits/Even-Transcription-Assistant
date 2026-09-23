-- =====================================================================
-- Migration 0115 — voice_centroid: who retired a centroid, and why.
--
-- WHY A SEPARATE MIGRATION. These two columns were first written into 0113 itself. The runner skips a
-- migration whose version is already in schema_migrations, so any environment that had applied the
-- earlier 0113 would never have received them, and 0113 would mean two different tables depending on
-- when it ran. Production is at 112 and has never applied 0113, but the shape of the fix should not
-- depend on that. ADD COLUMN IF NOT EXISTS converges every environment: one that applied the old 0113
-- gains the columns here, one that applied the new-and-now-reverted 0113 already has them and this is
-- a no-op, and a fresh database gets 0113 then 0115.
--
-- WHAT IT ADDS. Retiring a centroid revokes a biometric template. Recording only WHEN that happened
-- is not enough for an audit; retired_by names the actor and retired_reason says why
-- (`superseded_by:<id>` when a new generation replaced it, otherwise the revocation reason).
-- voice_centroid_retirement_chk then makes the three move together for good.
--
-- THE BACKFILL IS HONEST. A row already retired before this migration has no recorded provenance and
-- none can be invented, so it is marked as exactly that. Without it the CHECK would refuse to be
-- added to a database holding such a row, and the migration would fail where it is needed most.
--
-- ADDITIVE AND IDEMPOTENT: IF NOT EXISTS on both columns, a backfill that matches only unmarked rows,
-- and a constraint added only when absent. No row's real data is rewritten. App-owned: no GRANTs.
-- =====================================================================

ALTER TABLE voice_centroid ADD COLUMN IF NOT EXISTS retired_by     text;
ALTER TABLE voice_centroid ADD COLUMN IF NOT EXISTS retired_reason text;

COMMENT ON COLUMN voice_centroid.retired_by IS
  'Who retired this centroid (an actor id). Set with retired_at and retired_reason (voice_centroid_retirement_chk). unknown_pre_0115 marks a row retired before this migration.';
COMMENT ON COLUMN voice_centroid.retired_reason IS
  'Why it was retired: superseded_by:<id> when a new generation replaced it, otherwise the revocation reason. Set with retired_at (CHECK).';

-- Rows retired before 0115: say so, rather than invent an actor or leave the CHECK unaddable.
UPDATE voice_centroid
   SET retired_by     = coalesce(retired_by, 'unknown_pre_0115'),
       retired_reason = coalesce(retired_reason, 'retired before 0115; provenance not recorded')
 WHERE retired_at IS NOT NULL
   AND (retired_by IS NULL OR retired_reason IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_centroid_retirement_chk') THEN
    ALTER TABLE voice_centroid ADD CONSTRAINT voice_centroid_retirement_chk
      CHECK (retired_at IS NULL OR (retired_by IS NOT NULL AND retired_reason IS NOT NULL));
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (115, '0115_voice_centroid_retirement_provenance')
ON CONFLICT DO NOTHING;
