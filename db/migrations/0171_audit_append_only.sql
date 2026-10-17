-- =====================================================================
-- Migration 0171 — audit_log append-only for per-person and MCP rows (Scribe OAuth C4).
-- Gate (fable, binding): REQUIRED before SCRIBE_MCP_OAUTH is turned on in prod. V ordered a mandatory, append-only per-user audit.
--
-- WHAT. Two triggers on audit_log (migration 0001; the table every audit writer inserts into, lib/mcp/audit.ts and lib/admin-audit.ts alike):
--   audit_log_append_only_row  BEFORE UPDATE OR DELETE, FOR EACH ROW. Refuses (SQLSTATE 42501, message 'audit_append_only') when the row is PROTECTED:
--                              OLD.actor_type = 'person' OR OLD.action LIKE 'mcp.%'. On UPDATE it also refuses when NEW would BECOME protected
--                              (actor_type changed to 'person', or action changed to mcp.*), so an admin row cannot be rewritten into a fake person row.
--   audit_log_no_truncate      BEFORE TRUNCATE, FOR EACH STATEMENT. Always refuses: TRUNCATE skips row triggers, so it would empty the protected rows.
-- NOT PROTECTED, ON PURPOSE: every other row. lib/admin-audit.ts finishAdminAudit UPDATEs admin.* rows by id (metadata_json merge) and must keep working.
--
-- IDEMPOTENT. CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before each CREATE TRIGGER. A re-run replaces the same objects.
-- The protected value is compared as text (actor_type::text), so the function never depends on the enum value 'person' (0170) at create time.
-- GRANTS: none needed. A trigger function runs whoever fires the trigger and only raises; EXECUTE on functions is PUBLIC by default.
-- Down-migration: db/rollbacks/0171_audit_append_only.down.sql (by hand, never from here).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'audit_append_only' USING ERRCODE = '42501', DETAIL = 'TRUNCATE on audit_log is refused';
  END IF;
  IF OLD.actor_type::text = 'person' OR OLD.action LIKE 'mcp.%' THEN
    RAISE EXCEPTION 'audit_append_only' USING ERRCODE = '42501', DETAIL = TG_OP || ' of a person or mcp.* audit_log row is refused';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.actor_type::text = 'person' OR NEW.action LIKE 'mcp.%') THEN
    RAISE EXCEPTION 'audit_append_only' USING ERRCODE = '42501', DETAIL = 'UPDATE may not turn an audit_log row into a person or mcp.* row';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS audit_log_append_only_row ON audit_log;
CREATE TRIGGER audit_log_append_only_row BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

INSERT INTO schema_migrations (version, name)
VALUES (171, '0171_audit_append_only')
ON CONFLICT DO NOTHING;

COMMIT;
