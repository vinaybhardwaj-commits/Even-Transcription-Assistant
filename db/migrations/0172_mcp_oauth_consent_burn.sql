-- =====================================================================
-- Migration 0172 — single-use consent for the MCP OAuth consent page (Scribe OAuth R3, refute R2 finding 2).
--
-- WHAT. One table. A row is the peppered sha256 of a consent page's CSRF token, written by the FIRST Allow or Deny POST that presents it
-- (INSERT ... ON CONFLICT DO NOTHING RETURNING: exactly one caller wins, the same atomic single-use claim as mcp_oauth_code.used_at).
-- A replayed Allow, a double click, or Deny-then-Allow with the same consent cookie finds the row and mints nothing.
-- No token, code, email or URL is stored: the hash only. Rows are useless after the 5 min consent lifetime; nothing reads them after that.
--
-- IDEMPOTENT. CREATE TABLE / INDEX IF NOT EXISTS; the version row ON CONFLICT DO NOTHING.
-- Down-migration: db/rollbacks/0172_mcp_oauth_consent_burn.down.sql (by hand, never from here).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS mcp_oauth_consent_burn (
  csrf_hash   text PRIMARY KEY,
  burned_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_oauth_consent_burn_at_idx ON mcp_oauth_consent_burn (burned_at);

INSERT INTO schema_migrations (version, name)
VALUES (172, '0172_mcp_oauth_consent_burn')
ON CONFLICT DO NOTHING;

COMMIT;
