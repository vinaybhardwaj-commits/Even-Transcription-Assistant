-- 0023_lvc_proposals_and_provenance.sql — LAB-MCP Phase 2 (F13 provenance · F14 proposals/ratifications).
-- Applied BY HAND. Idempotent. STRICTLY ADDITIVE: no column dropped, no row rewritten, no existing
-- value modified. `lvc_recommendations` is NEVER written by the F14 path — proposals stage here and
-- only lvc_ratify promotes one.
--
-- ⚠️ INFERRED against a live schema this sandbox cannot see. Every statement is a no-op if already
-- applied. Validate the column names on `mksap_chunks` and `lvc_recommendations` before running.

-- ── F13: provenance on ingest ────────────────────────────────────────────────
-- The escape hatch (provenance='internal-protocol') covers the 332 Even Clinical Protocol chunks,
-- which have no external citation because they ARE the source. Everything else must cite.
-- Existing 850 rows are left NULL — backfilled only where derivable, NEVER guessed.
-- ⚠️ TABLE NAME CORRECTED (26 Jul): the corpus lives in `mksap_chunks`, NOT a table called
-- `corpus`. The PRD and the earlier draft of this migration both said `corpus`; grounding
-- CORPUS_QUARANTINE_INSERT_SQL in lib/lab.ts showed the real target. Applying the previous version
-- would have errored on a non-existent table (or, worse, altered an unrelated one).
ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS citation_url text;
ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS citation_doi text;
ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS citation_pmid text;
ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS source_release_year int;
ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS license_status text;
ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS provenance text;
CREATE INDEX IF NOT EXISTS mksap_chunks_license_status_idx ON mksap_chunks (license_status);

-- ── F14: the staging table. Mirrors lvc_recommendations + governance columns ──
-- status is the workflow; 'rejected' is FIRST-CLASS and keeps its reason. A rejected proposal is
-- evidence about the rulebook and is never deleted.
CREATE TABLE IF NOT EXISTS lvc_recommendation_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement           text NOT NULL,
  rationale           text,
  evidence_note       text,
  source              text,
  category            text,
  action_type         text,
  specialty           text,
  keywords            jsonb,
  -- provenance (same gate as F13)
  citation_url        text,
  citation_doi        text,
  citation_pmid       text,
  source_release_year int,
  license_status      text,
  provenance          text,
  -- governance
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','ratified','rejected')),
  proposed_by         text NOT NULL,
  proposed_at         timestamptz NOT NULL DEFAULT now(),
  -- A10.4: a deliberate replacement of an existing statement, which is how a near-duplicate is
  -- allowed through at all. NOT a foreign key — it may reference lvc_recommendations OR a proposal.
  supersedes_id       text,
  rejected_reason     text,
  promoted_id         text
);
CREATE INDEX IF NOT EXISTS lvc_proposals_status_idx ON lvc_recommendation_proposals (status, proposed_at DESC);

-- ── F14: the append-only ratification ledger ─────────────────────────────────
-- Compensating control for decision 11: the Lab MCP has no user identity, so confirm:true is a
-- convention. This ledger is what makes a ratification accountable after the fact.
CREATE TABLE IF NOT EXISTS lvc_ratifications (
  id            bigserial PRIMARY KEY,
  proposal_id   uuid NOT NULL REFERENCES lvc_recommendation_proposals (id),
  decision      text NOT NULL CHECK (decision IN ('ratified','rejected')),
  ratified_by   text NOT NULL,
  rationale     text NOT NULL,
  reason        text,
  -- The lvc_recommendations id this ratification promoted TO. lvc_ratify's INSERT supplies it and
  -- the runtime DDL in lib/mcp-tools.ts always created it; this file omitted it, so whichever ran
  -- FIRST decided whether the column existed — CREATE TABLE IF NOT EXISTS makes the loser a no-op.
  -- Added by V before applying 0023 live, and reconciled here so repo and database agree.
  promoted_id   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Belt-and-braces: converges a database whose lvc_ratifications was created by the RUNTIME DDL
-- before this column existed there. A no-op wherever the column is already present, which includes
-- the live database. This is what makes the CREATE-vs-ALTER ordering stop mattering.
ALTER TABLE lvc_ratifications ADD COLUMN IF NOT EXISTS promoted_id text;
CREATE INDEX IF NOT EXISTS lvc_ratifications_proposal_idx ON lvc_ratifications (proposal_id, created_at DESC);
