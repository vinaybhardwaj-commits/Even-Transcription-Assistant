-- Down-migration for 0172_mcp_oauth_consent_burn.sql. RUN BY HAND ONLY (lives in db/rollbacks/ because the runner applies every NNNN_*.sql in db/migrations/).
-- Without the table every consent POST fails closed (server_error): roll back the R3 code first.
BEGIN;
DROP TABLE IF EXISTS mcp_oauth_consent_burn;
DELETE FROM schema_migrations WHERE version = 172;
COMMIT;
