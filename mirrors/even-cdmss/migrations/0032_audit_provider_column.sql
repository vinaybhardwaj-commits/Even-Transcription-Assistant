-- 0032_audit_provider_column.sql — 2 Aug 2026
-- PROVIDER-SWITCH PRD §5 (Unit B) — attribution: which PROVIDER served the grading call.
--
-- WHY. `model` alone cannot answer "who graded this". The SAME model id arrives by more than one
-- route: `google/gemini-2.5-pro` is Gemini via the OpenRouter bridge, `gemini-2.5-pro` is Gemini
-- via Vertex — and a future `bedrock:anthropic.claude-x` adds a third. When Vertex was disabled on
-- 26 July and again when the bridge's 110 s ceiling silently degraded every median-or-slower audit
-- to the local model from 30 July, the stored rows could not say which path had been taken. THAT
-- AMBIGUITY IS A LARGE PART OF WHY A THREE-DAY OUTAGE WENT UNNOTICED: the column that should have
-- shouted "these were served somewhere else" was carrying a model name that looked normal.
--
-- ADDITIVE, IDEMPOTENT, NO BACKFILL. Both statements are `ADD COLUMN IF NOT EXISTS`, so running
-- this twice is a no-op. No index (nothing filters on it yet — Unit C decides), no DEFAULT, and
-- deliberately no backfill: historical rows keep `provider IS NULL`, which honestly means
-- "recorded before attribution existed". Unit C's grader tier depends on that being
-- DISTINGUISHABLE from a row that genuinely knows its provider — a default of 'unknown' or a
-- guessed backfill would destroy exactly the distinction this column is for.
--
-- The writers tolerate this migration NOT having run: both stores probe for the column and omit it
-- from the INSERT when absent (the same deploy-before-migrate discipline as quieting_gen,
-- completeness_items and displayed_band). So the deploy is safe in either order.

ALTER TABLE opd_note_audits      ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE ipd_discharge_audits ADD COLUMN IF NOT EXISTS provider text;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- ROLLBACK. Dropping the column loses the attribution recorded since the deploy; prefer leaving it
-- in place (an unused nullable text column costs nothing). If it must go:
--
--   ALTER TABLE opd_note_audits      DROP COLUMN IF EXISTS provider;
--   ALTER TABLE ipd_discharge_audits DROP COLUMN IF EXISTS provider;
