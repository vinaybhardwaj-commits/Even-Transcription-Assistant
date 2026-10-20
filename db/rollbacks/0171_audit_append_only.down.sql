-- Down-migration for 0171_audit_append_only.sql. RUN BY HAND ONLY (lives in db/rollbacks/ because the runner applies every NNNN_*.sql in db/migrations/).
-- Removes the append-only guard on audit_log. Person and mcp.* rows become mutable again: do NOT run while SCRIBE_MCP_OAUTH is on in prod (C4 gate).
BEGIN;
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
DROP TRIGGER IF EXISTS audit_log_append_only_row ON audit_log;
DROP FUNCTION IF EXISTS audit_log_append_only();
DELETE FROM schema_migrations WHERE version = 171;
COMMIT;
