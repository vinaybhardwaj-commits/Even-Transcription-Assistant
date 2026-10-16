-- =====================================================================
-- Migration 0170 — MCP OAuth (slice O2): allowlist, clients, one-time codes, tokens.
-- Number 0170 reserved by gating-lead.
-- Spec: SPEC-SCRIBE-MCP-OAUTH-PER-PERSON-16OCT.md §5. Nothing here is read by /api/mcp yet (that is slice O3).
--
-- ADDITIVE AND IDEMPOTENT. CREATE ... IF NOT EXISTS only. No grants, no data, no seeded rows (the allowlist is seeded by gating at O3).
-- Hashes are sha256(MCP_OAUTH_TOKEN_PEPPER || value): no token, code or refresh token is stored in clear.
-- Down-migration: db/rollbacks/0170_mcp_oauth.down.sql (by hand, never from here).
-- =====================================================================

BEGIN;

-- OAUTH-O3: per-person audit rows use actor_type 'person' (spec §12). audit_log.actor_type is the enum actor_type (migration 0001: admin, doctor, system).
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS is idempotent. Postgres 12+ allows it inside a transaction block provided the new value is not USED in the same transaction;
-- nothing in this file uses it, and the app/api/run-migrations runner (one sql.transaction per file) is therefore fine. The value is first used by the app after the migration commits.
ALTER TYPE actor_type ADD VALUE IF NOT EXISTS 'person';

CREATE TABLE IF NOT EXISTS mcp_person (
  email       text PRIMARY KEY CONSTRAINT mcp_person_email_lower_chk CHECK (email = lower(email)),
  scopes      text[] NOT NULL,
  status      text NOT NULL DEFAULT 'active' CONSTRAINT mcp_person_status_chk CHECK (status IN ('active', 'revoked')),
  granted_by  text,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  text
);

CREATE TABLE IF NOT EXISTS mcp_oauth_client (
  client_id     text PRIMARY KEY,
  kind          text NOT NULL CONSTRAINT mcp_oauth_client_kind_chk CHECK (kind IN ('cimd', 'dcr')),
  redirect_uris text[] NOT NULL,
  metadata_url  text,
  client_name   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE TABLE IF NOT EXISTS mcp_oauth_code (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL,
  email           text NOT NULL,
  code_challenge  text NOT NULL,
  redirect_uri    text NOT NULL,
  resource        text NOT NULL,
  scopes          text[] NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

CREATE TABLE IF NOT EXISTS mcp_oauth_token (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL CONSTRAINT mcp_oauth_token_kind_chk CHECK (kind IN ('access', 'refresh')),
  email       text NOT NULL,
  client_id   text NOT NULL,
  scopes      text[] NOT NULL,
  resource    text NOT NULL,
  family_id   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  rotated_to  text
);

-- FAMILY TOMBSTONE (O2-FIX1, MUST-2). A row here means "this token family is revoked, and nothing more may be issued into it". Revoking a family inserts the tombstone FIRST, then
-- updates the token rows; inserting a token is INSERT ... WHERE NOT EXISTS (tombstone), and the issuer re-checks the tombstone after inserting, so a redemption racing a revoke can
-- never leave a live token behind. Append-only: nothing deletes a tombstone.
CREATE TABLE IF NOT EXISTS mcp_oauth_family (
  family_id   text PRIMARY KEY,
  revoked_at  timestamptz NOT NULL DEFAULT now(),
  reason      text
);

CREATE INDEX IF NOT EXISTS mcp_oauth_token_email_idx   ON mcp_oauth_token (email);
CREATE INDEX IF NOT EXISTS mcp_oauth_token_family_idx  ON mcp_oauth_token (family_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_code_expires_idx  ON mcp_oauth_code (expires_at);

INSERT INTO schema_migrations (version, name)
VALUES (170, '0170_mcp_oauth')
ON CONFLICT DO NOTHING;

COMMIT;
