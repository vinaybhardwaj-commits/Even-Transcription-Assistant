# OUTBOX cloud-scribe-oauth-c4 (append-only)
- branch cloudpane/cloud-scribe-oauth-c4/0171 from origin/scribe/oauth-person e4c1406f
- table found: audit_log (0001); writers lib/admin-audit.ts, lib/mcp/audit.ts
- added db/migrations/0171_audit_append_only.sql, db/rollbacks/0171_audit_append_only.down.sql, tests/unit/audit-append-only-0171-pg.test.ts
- local PG 16.15: all 161 migrations + 0171 apply; new test 9/9 pass; with 0171 removed 6/9 fail (discriminating)
- gate: tsc 0, typecheck:tests 0, build 0, vitest 52 docker-guard fails / 0 with ETA_ALLOW_SKIP_E2E=1, scrub rc 0; B1 mcp-oauth-o3-pg.test.ts:152 person DELETE will fail on docker hosts
- pushed report cloudpane-reports/SCRIBE-OAUTH-C4-BUILD.md to cloudpane/cloud-scribe-oauth-c4/0171
