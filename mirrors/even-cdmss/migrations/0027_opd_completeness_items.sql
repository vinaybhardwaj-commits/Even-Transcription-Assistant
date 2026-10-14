-- 0027_opd_completeness_items — persist the OPD per-field completeness array (item D-1, settled by
-- V 27 Jul 2026; PRD §1.1 addendum A-6 → D-1, kickoff §12.1a gap 2).
--
-- WHY THIS DOES NOT CONTRADICT §3. §3 says "no column is added to opd_note_audits" — that rule is
-- about DERIVED SCORES, which stay derived-on-read and are never stored. `completeness_items` is a
-- STORED INPUT: the per-field statuses the engine already computes, which is exactly what
-- ipd_discharge_audits.report has carried since 0013. Without it the OPD engine's structured
-- emission goes nowhere and the OPD tab is live-but-inert.
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS on a nullable jsonb takes no table rewrite and
-- no lock of consequence — existing rows get NULL.
--
-- NO BACKFILL. Decision §1.5 stands: OPD weighting is new-audits-only. All 25,130 historical rows
-- keep `completeness_items` NULL and keep reading their stored flat `completeness_pct`. A NULL here
-- means "we never recorded per-field detail for this note", NOT "every field was missing" — the
-- read path is written to honour that distinction and is tested on it.

ALTER TABLE opd_note_audits
  ADD COLUMN IF NOT EXISTS completeness_items jsonb;

-- Lets the impact-preview empty state count "audits carrying per-field detail" (PRD §5.3, kickoff
-- §12.1a) without scanning 25,130 rows. Partial: only the non-null rows are of interest, and while
-- they are the minority that is the whole point of the index.
CREATE INDEX IF NOT EXISTS opd_note_audits_completeness_items_present
  ON opd_note_audits (audited_at DESC) WHERE completeness_items IS NOT NULL;
