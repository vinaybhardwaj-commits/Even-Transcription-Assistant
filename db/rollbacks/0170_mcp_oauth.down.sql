-- Down-migration for 0170_mcp_oauth.sql. RUN BY HAND ONLY (lives in db/rollbacks/ because the runner applies every NNNN_*.sql in db/migrations/).
-- Drops the five OAuth tables and their indexes. Every issued token and code is lost (people sign in again); the allowlist is lost too, so keep a copy of mcp_person first.
BEGIN;
DROP TABLE IF EXISTS mcp_oauth_family;
DROP TABLE IF EXISTS mcp_oauth_token;
DROP TABLE IF EXISTS mcp_oauth_code;
DROP TABLE IF EXISTS mcp_oauth_client;
DROP TABLE IF EXISTS mcp_person;
DELETE FROM schema_migrations WHERE version = 170;
-- NOT reverted: the 'person' value of the actor_type enum (Postgres cannot drop an enum value). It is harmless once no row uses it; rows already written with actor_type 'person' keep it.
COMMIT;
