-- 0062_newcat_ro_role.sql — read-only role for newcat (Even's audit/decision agent platform), 13 Oct 2026.
--
-- newcat reads existing CDMSS audits so its agents can join to them and avoid duplicating them
-- (newcat PLATFORM-SPEC F3; signed by fable 13 Oct). newcat keeps its own database for its writes.
-- The role is READ-ONLY: default_transaction_read_only, SELECT on 17 named tables only, no default privileges,
-- no schema-wide grant, no write to any table. The password is NOT in this file: it is set out of band
-- (ALTER ROLE ... PASSWORD from a 0600 file) and lives only in newcat's env CDMSS_DATABASE_URL_RO.
-- Idempotent: safe to run twice. CDMSS has no migration ledger (migrations are applied by hand), so nothing retries this.
-- Rollback: REVOKE ALL ON ALL TABLES IN SCHEMA public FROM newcat_ro; REVOKE USAGE ON SCHEMA public FROM newcat_ro;
--           REVOKE CONNECT ON DATABASE neondb FROM newcat_ro; DROP ROLE newcat_ro.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'newcat_ro') THEN
    CREATE ROLE newcat_ro LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

ALTER ROLE newcat_ro CONNECTION LIMIT 10;
-- default_transaction_read_only is a guard rail only: a session can SET it off. The real fence is that
-- newcat_ro holds no write grant on anything (checked before apply: no PUBLIC table grants, no PUBLIC CREATE
-- on schema public, no PUBLIC-executable SECURITY DEFINER function that writes).
ALTER ROLE newcat_ro SET default_transaction_read_only = on;
ALTER ROLE newcat_ro SET statement_timeout = '15s';

GRANT CONNECT ON DATABASE neondb TO newcat_ro;
GRANT USAGE ON SCHEMA public TO newcat_ro;

GRANT SELECT ON TABLE
  opd_note_audits,
  ot_note_audits,
  ot_surgeon_map,
  ipd_discharge_audits,
  ipd_episode_audits,
  preop_findings,
  preop_finding_versions,
  readmission_findings,
  readmission_finding_versions,
  clinical_states,
  clinical_state_versions,
  lvc_recommendations,
  opd_audit_feedback,
  opd_feedback_adjudications,
  opd_gov_signal,
  opd_audit_triage,
  scoring_policy_versions
TO newcat_ro;
