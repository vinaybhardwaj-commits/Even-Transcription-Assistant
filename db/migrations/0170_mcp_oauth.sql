-- =====================================================================
-- Migration 0170 — MCP OAuth (slice O2): allowlist, clients, one-time codes, tokens, email sign-in codes; own login + per-user audit (18 Oct: key-to-email identity, owner security log).
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

-- EMAIL SIGN-IN CODE (V ruling 18 Oct 2026: no Google). One row per mailed 6-digit code. code_hash = sha256(MCP_OAUTH_TOKEN_PEPPER || pending_id || code): the code itself is never stored, and a code only
-- matches the pending flow it was issued to. attempts counts tries on this row; used_at makes it single use; expires_at is 10 minutes after creation. No data is seeded.
CREATE TABLE IF NOT EXISTS mcp_oauth_email_code (
  id          bigserial PRIMARY KEY,
  pending_id  text NOT NULL,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- OWN LOGIN + PER-USER AUDIT (Fable spec 18 Oct 2026; amends this still-unmerged migration, no new number).
-- mcp_identity: one row per person who may hold a key. status active | revoked | blacklisted. A blacklisted address is never re-issued a key by the CLI or /admin/mcp-keys; only V editing the row can undo it.
-- mcp_key: one key -> exactly one email. key_hash = plain sha256 hex of the key (the same form as the SCRIBE_MCP_TOKENS maps), never the key. scope read | admin. Rotation sets rotated_from and revokes the old key.
CREATE TABLE IF NOT EXISTS mcp_identity (
  email       text PRIMARY KEY CONSTRAINT mcp_identity_email_lower_chk CHECK (email = lower(email)),
  status      text NOT NULL DEFAULT 'active' CONSTRAINT mcp_identity_status_chk CHECK (status IN ('active', 'revoked', 'blacklisted')),
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_key (
  key_id        text PRIMARY KEY,
  email         text NOT NULL REFERENCES mcp_identity (email),
  scope         text NOT NULL CONSTRAINT mcp_key_scope_chk CHECK (scope IN ('read', 'admin')),
  key_hash      text NOT NULL UNIQUE CONSTRAINT mcp_key_hash_chk CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  rotated_from  text,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_key_email_idx ON mcp_key (email);

-- Existing allowlisted people become identities (no key is seeded here: a key's hash lives only in the Vercel token maps, which SQL cannot read; scripts/mcp-keys.ts seed-env links them from a mapping file V supplies).
INSERT INTO mcp_identity (email, status, created_by)
SELECT email, CASE WHEN status = 'active' THEN 'active' ELSE 'revoked' END, 'migration-0170' FROM mcp_person
ON CONFLICT DO NOTHING;

-- ADDENDUM 1 (18 Oct): a session is bound to the key it signed in with (key_id on the code and on every token of the family; checked on every call, so revoking the key or the email kills the session at once),
-- and V approves an address once for the self_after_approval code route (code_self_approved_at; cleared when the identity is revoked or blacklisted).
ALTER TABLE mcp_oauth_code  ADD COLUMN IF NOT EXISTS key_id text;
-- R3 F3: the 15-minute address lock is anchored on the time of the last wrong try (stamped on every try), not on when the code was created.
ALTER TABLE mcp_oauth_email_code ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE mcp_oauth_token ADD COLUMN IF NOT EXISTS key_id text;
ALTER TABLE mcp_identity ADD COLUMN IF NOT EXISTS code_self_approved_at timestamptz;
ALTER TABLE mcp_identity ADD COLUMN IF NOT EXISTS code_self_approved_by text;
CREATE INDEX IF NOT EXISTS mcp_oauth_token_key_idx ON mcp_oauth_token (key_id);

-- R3 F4: the two 16 Oct 2026 revocations (Bhavesh, Chandan) are BLACKLISTED by the migration itself, not by a seed file. This repo holds no address for either (names only), so the match is the
-- allowlist/identity rows whose local part STARTS WITH the first name on the company domain; any such row becomes blacklisted (an upsert that overrides revoked/active), and its keys are stamped revoked.
-- No row is invented: if neither person is in mcp_person or mcp_identity yet, nothing matches and scripts/mcp-keys.ts blacklist <email> (or `seed`) must add the exact address - reported UNVERIFIED.
INSERT INTO mcp_identity (email, status, created_by)
SELECT email, 'blacklisted', 'migration-0170-16oct' FROM mcp_person WHERE email ~ '^(bhavesh|chandan)[^@]*@even\.in$'
ON CONFLICT (email) DO UPDATE SET status = 'blacklisted';
UPDATE mcp_identity SET status = 'blacklisted' WHERE email ~ '^(bhavesh|chandan)[^@]*@even\.in$' AND status <> 'blacklisted';
UPDATE mcp_key SET revoked_at = now() WHERE revoked_at IS NULL AND email IN (SELECT email FROM mcp_identity WHERE status = 'blacklisted');
UPDATE mcp_person SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()) WHERE email IN (SELECT email FROM mcp_identity WHERE status = 'blacklisted') AND status = 'active';

-- OWNER SECURITY LOG: V's own calls and nothing more. ts, key_id, tool, outcome. NO subject ids, NO args, NO email. Excluded from audit_log, the governance view and the digest; read only at /admin/mcp-seclog.
-- UPDATE and TRUNCATE are refused; DELETE is allowed only for a row older than 30 days (the retention purge).
CREATE TABLE IF NOT EXISTS mcp_owner_seclog (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  key_id   text NOT NULL,
  tool     text NOT NULL,
  outcome  text NOT NULL CONSTRAINT mcp_owner_seclog_outcome_chk CHECK (outcome IN ('ok', 'error', 'refused'))
);
CREATE INDEX IF NOT EXISTS mcp_owner_seclog_ts_idx ON mcp_owner_seclog (ts);

CREATE OR REPLACE FUNCTION mcp_owner_seclog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.ts < now() - interval '30 days' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'seclog_append_only' USING ERRCODE = '42501';
END
$$;
DROP TRIGGER IF EXISTS mcp_owner_seclog_row ON mcp_owner_seclog;
CREATE TRIGGER mcp_owner_seclog_row BEFORE UPDATE OR DELETE ON mcp_owner_seclog FOR EACH ROW EXECUTE FUNCTION mcp_owner_seclog_guard();
DROP TRIGGER IF EXISTS mcp_owner_seclog_trunc ON mcp_owner_seclog;
CREATE TRIGGER mcp_owner_seclog_trunc BEFORE TRUNCATE ON mcp_owner_seclog FOR EACH STATEMENT EXECUTE FUNCTION mcp_owner_seclog_guard();

CREATE INDEX IF NOT EXISTS mcp_oauth_token_email_idx   ON mcp_oauth_token (email);
CREATE INDEX IF NOT EXISTS mcp_oauth_token_family_idx  ON mcp_oauth_token (family_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_code_expires_idx  ON mcp_oauth_code (expires_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_email_code_pending_idx ON mcp_oauth_email_code (pending_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_email_code_email_idx   ON mcp_oauth_email_code (email, created_at);

INSERT INTO schema_migrations (version, name)
VALUES (170, '0170_mcp_oauth')
ON CONFLICT DO NOTHING;

COMMIT;
