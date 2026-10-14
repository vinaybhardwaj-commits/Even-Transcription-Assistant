import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the readmission_finding_versions table (Readmissions R8.1 — PRD
// CDMSS-READMISSIONS-R8.1-FINDING-VERSIONS v1.0, migration number 0035; a reference
// copy of this DDL sits in migrations/0035_readmission_finding_versions.sql).
// Additive + idempotent; mirrors migrate-readmissions. Auth: ADMIN_TOKEN (Bearer /
// ?token=) OR admin session.
//
// One row per READING of a case: capture_reason 'overwrite' keeps the audited reading
// a re-audit or refresh was about to destroy (written by saveAuditResult, in the same
// statement as its UPDATE); 'replay' keeps a deliberate stability re-run that never
// touched the live row (written by /api/admin/readmission-replay). O1: the whole row
// as JSON plus scalar copies for querying; O4: nothing user-facing reads this table.
// No backfill: the 83 already-audited cases have only the reading that exists today —
// there is nothing to recover.
// ⚠️ INFERRED SQL/DDL throughout: this sandbox has no live Neon.

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS readmission_finding_versions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source      TEXT NOT NULL DEFAULT 'standalone',
      capture_reason  TEXT NOT NULL,
      dedup_key       TEXT NOT NULL,
      engine_version  TEXT NOT NULL,
      avoidable       TEXT,
      planned         TEXT,
      same_condition  TEXT,
      preventable_injury TEXT,
      audit_status    TEXT,
      model           TEXT,
      provider        TEXT,
      audited_at      TIMESTAMPTZ,
      template_coverage JSONB,
      row_snapshot    JSONB NOT NULL,
      trace_id        TEXT
    )`;
    steps.create_table = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS readmission_finding_versions_key_idx
      ON readmission_finding_versions (dedup_key, engine_version, captured_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS readmission_finding_versions_reason_idx
      ON readmission_finding_versions (capture_reason, captured_at DESC)`;
    steps.indexes = 'ok';
    const counts = (await sql`SELECT count(*)::int AS n FROM readmission_finding_versions`) as Array<{ n: number }>;
    steps.rows = String(counts[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
