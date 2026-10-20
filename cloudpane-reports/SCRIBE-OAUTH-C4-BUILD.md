# SCRIBE-OAUTH-C4-BUILD — migration 0171, audit_log append-only (cloud-scribe-oauth-c4, 17 Oct 2026)

Branch `cloudpane/cloud-scribe-oauth-c4/0171` from `origin/scribe/oauth-person` e4c1406f. No PHI, no secrets, no live DB, no deploy.

## Table found
`audit_log` (0001; actor_type is the enum actor_type, 'mcp' added by 0137, 'person' by 0170). The O3 per-person writer and lib/admin-audit.ts both insert there.

## Files
- `db/migrations/0171_audit_append_only.sql` (0170 header/BEGIN/COMMIT style, self-records version 171)
- `db/rollbacks/0171_audit_append_only.down.sql` (by hand only, like 0168-0170)
- `tests/unit/audit-append-only-0171-pg.test.ts` (new; existing tests untouched)

## Trigger text summary
- Function `audit_log_append_only()` plpgsql, CREATE OR REPLACE, plain `$$` body (the runner's splitter is `$$`-aware).
- `audit_log_append_only_row` BEFORE UPDATE OR DELETE FOR EACH ROW: RAISE 'audit_append_only' ERRCODE 42501 when `OLD.actor_type::text = 'person' OR OLD.action LIKE 'mcp.%'`; on UPDATE also when NEW is person or mcp.*.
- `audit_log_no_truncate` BEFORE TRUNCATE FOR EACH STATEMENT: always raises the same.
- DROP TRIGGER IF EXISTS before each CREATE. GRANTs: none needed (trigger function only raises; EXECUTE is PUBLIC by default).
- Every other row (admin.*, stt.paid_call, install.*) stays UPDATE/DELETE-able.

## Tests (local PostgreSQL 16.15 from apt; all 161 migrations applied in order, then 0171)
Harness: docker via tests/support/s1-pg.ts when the daemon answers; else `ETA_PG_LOCAL_PSQL` (JSON argv for a local psql), its own DB per run. Docker is down here, so it ran local.
| # | Test | Result |
|---|---|---|
| 1 | INSERT person and mcp rows (system, mcp, person actors) | pass |
| 2 | person row UPDATE (metadata, actor_type) refused, DELETE refused, row unchanged | pass |
| 3 | mcp.* row, actor system/admin/mcp/doctor: UPDATE and DELETE refused | pass |
| 4 | admin row action -> 'mcp.x' refused; actor_type -> 'person' refused | pass |
| 5 | TRUNCATE refused, row count unchanged | pass |
| 6 | lib/admin-audit.ts insertAdminAuditStrict + finishAdminAudit UPDATE by id of admin.* row succeeds (real module) | pass |
| 7 | finishAdminAudit on a person-actor row returns false, does not throw | pass |
| 8 | non-protected row UPDATE and DELETE still work | pass |
| 9 | 0171 applied twice more: same 2 triggers, 1 function, 1 schema_migrations row, guard on | pass |
Mutation check: with 0171 removed, 6/9 fail, so the tests depend on the triggers.

## Gate
- `npx tsc --noEmit` rc 0; `npm run typecheck:tests` rc 0; `npm run build` rc 0.
- `npx vitest run --poolOptions.threads.maxThreads=4` (vitest 2.1.9 --no-save, as gate.yml pins): 52 failed / 8233 passed / 1186 skipped. All 52 are the "REQUIRED PROOF ran, or was skipped deliberately / needs Docker" guards (no daemon here).
- Same run with `ETA_ALLOW_SKIP_E2E=1`: 454 files, 8285 passed, 1186 skipped, 0 failed, rc 0. The new suite ran there (9/9).
- `bash scripts/steward/scrub.sh origin/scribe/oauth-person..HEAD` (gitleaks 8.30.1, checksum from steward-scrub.yml): rc 0.

## Blockers
- B1 - `tests/unit/mcp-oauth-o3-pg.test.ts:152` (also :75) runs `DELETE FROM audit_log WHERE actor_id = 'person:alice…'`. Earlier steps in that suite write person rows for ALICE, so on a Docker host it will now fail with audit_append_only. UNPROVEN here (that suite is Docker-only and skipped). The brief said not to change existing tests, so I left it. One fix: scope that test's queries by created_at or id and drop the DELETE. Fable decides.

## Adjacent
- A1 - The table owner can still `ALTER TABLE audit_log DISABLE TRIGGER` or `DROP TRIGGER`. If prod runs the app as the owner role, the guard blocks app code paths but not a deliberate owner. Separating the app role from the owner would close that gap. Out of scope.
- A2 - The other DELETEs on audit_log in existing tests (consult-index-pg stt.paid_call, sarvam-runner-pg job rows, fleet-rekey-pg inst_rk_ install.* rows) delete rows that are not protected, so they are unaffected.
