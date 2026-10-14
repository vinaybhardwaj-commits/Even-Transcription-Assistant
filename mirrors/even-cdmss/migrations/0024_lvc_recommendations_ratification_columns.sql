-- 0024_lvc_recommendations_ratification_columns.sql — LAB-MCP Phase 2, F14 ratification audit trail.
-- Applied BY HAND. Idempotent. STRICTLY ADDITIVE: three nullable columns, no data touched.
--
-- SEPARATE FROM 0023 DELIBERATELY. 0023 targets `mksap_chunks` (F13 corpus provenance); this targets
-- `lvc_recommendations` (F14). Mixing two tables into one migration is exactly how the wrong-table
-- defect in 0023's first draft happened — it said `corpus`, which does not exist. One migration, one
-- table, so a mis-targeted statement cannot hide behind a correct one.
--
-- ⚠️ ORCHESTRATOR-VALIDATED, not inferred. The live schema of lvc_recommendations was measured on
-- 26 Jul: citation_url, citation_doi, citation_pmid, source_release_year, license_status and
-- provenance ALREADY EXIST. The three below did not, and F14's promotion INSERT names them.
--
-- WHY THESE LIVE ON THE ROW AND NOT ONLY IN THE LEDGER. lvc_ratify's `confirm:true` is a convention,
-- not authentication — the Lab MCP has no user identity (decision 11). The compensating control is
-- that a promoted statement carries its own provenance: who proposed it, who ratified it, when.
-- lvc_ratifications remains the append-only ledger; these columns make the row self-describing so an
-- auditor reading the rulebook alone can see the trail without joining.

ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS proposed_by text;
ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS ratified_by text;
ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS ratified_at timestamptz;

-- Ratified rows are the ones an auditor will filter for; the 111 existing rows are all NULL here.
CREATE INDEX IF NOT EXISTS lvc_recommendations_ratified_at_idx ON lvc_recommendations (ratified_at DESC);
