-- Down-migration for 0173_mcp_blacklist_applied.sql. RUN BY HAND ONLY (lives in db/rollbacks/ because the runner applies every NNNN_*.sql in db/migrations/).
-- Without the table the identity-on guard fails closed (503): switch SCRIBE_MCP_IDENTITY off first, or roll back the R5 code first.
BEGIN;
DROP TABLE IF EXISTS mcp_blacklist_applied;
DELETE FROM schema_migrations WHERE version = 173;
COMMIT;
