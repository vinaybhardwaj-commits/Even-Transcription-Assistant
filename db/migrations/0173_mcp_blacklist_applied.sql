-- =====================================================================
-- Migration 0173 — marker rows for the private blacklist file (Scribe OAuth R5, Fable ruling 18 Oct).
--
-- WHAT. One table. The blacklist-file CLI writes one row each time it applies the private file: the file's sha256, the address COUNT and when. No address is stored.
-- With SCRIBE_MCP_IDENTITY=on the email sign-in routes (start, which also serves resend, and verify) refuse with 503 until at least one row exists.
--
-- IDEMPOTENT. CREATE TABLE IF NOT EXISTS; the version row ON CONFLICT DO NOTHING.
-- Down-migration: db/rollbacks/0173_mcp_blacklist_applied.down.sql (by hand, never from here).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS mcp_blacklist_applied (
  id           bigserial PRIMARY KEY,
  file_sha256  text NOT NULL,
  address_count integer NOT NULL CONSTRAINT mcp_blacklist_applied_count_chk CHECK (address_count > 0),
  applied_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name)
VALUES (173, '0173_mcp_blacklist_applied')
ON CONFLICT DO NOTHING;

COMMIT;
