-- 0022_stable_ref.sql — LAB-MCP Phase 1 (F1 stable_ref, F2/F4 ledger metadata).
-- Applied BY HAND. Idempotent. STRICTLY ADDITIVE: no column is dropped, no row is rewritten, no
-- existing value is modified. Nothing here touches scoring.
--
-- stable_ref itself is a JSONB KEY inside opd_note_audits.findings[], not a column — it is written by
-- stampFindingIdentity (forward) and by /api/admin/backfill-stable-ref (history). This migration only
-- adds the index that makes looking a finding up BY that key affordable, plus the ledger column that
-- lets a cluster_key stop smuggling the engine version inside its identity.
--
-- ⚠️ INFERRED AGAINST A LIVE SCHEMA I CANNOT SEE. Both statements are written to be no-ops if already
-- applied. The GIN index below takes a brief ACCESS SHARE-blocking lock while it builds; on a table of
-- this size that is seconds, but run it off-peak. If the lock is a concern, run the CONCURRENTLY
-- variant noted beneath it instead — it cannot run inside a transaction block.

-- 1) Lookup support for findings-by-stable_ref (and, incidentally, every other findings @> query).
--    jsonb_path_ops is chosen over the default: it is smaller and faster for the @> containment
--    operator, which is the only operator these lookups use.
CREATE INDEX IF NOT EXISTS opd_note_audits_findings_gin
  ON opd_note_audits USING GIN (findings jsonb_path_ops);
-- Non-blocking alternative (run instead of the above, OUTSIDE a transaction, if lock time matters):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS opd_note_audits_findings_gin
--     ON opd_note_audits USING GIN (findings jsonb_path_ops);

-- 2) Ledger: engine_version becomes its own nullable column instead of a suffix on cluster_key.
--    The ledger is APPEND-ONLY — existing '<signal>@<version>' rows are NOT rewritten here or
--    anywhere; they are normalised on read (normalizeClusterKey). This column exists so NEW rows can
--    record the version as metadata rather than as identity.
--    Also ensured at call time in lib/mcp-tools.ts (ensureAdjudicationTable), so this statement is a
--    belt-and-braces no-op if the tool has already run.
CREATE TABLE IF NOT EXISTS opd_feedback_adjudications (
  id bigserial PRIMARY KEY,
  cluster_key text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('fix','suppress','accept','defer','monitor')),
  rationale text NOT NULL,
  prd_ref text,
  author text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE opd_feedback_adjudications ADD COLUMN IF NOT EXISTS engine_version text;
