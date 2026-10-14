import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the ipd_discharge_audits table (IPD Discharge Audit S3; deferred from M1 for parity
// with the OPD migrate pattern). Idempotent. Mirrors migrations/0013_ipd_discharge_audits.sql.
// Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session cookie.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS ipd_discharge_audits (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audited_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source             TEXT NOT NULL DEFAULT 'standalone',
      document_id            TEXT NOT NULL,
      ip_uid                 TEXT,
      member_id              TEXT,
      speciality             TEXT,
      discharge_type         TEXT,
      los_days               INT,
      discharged_at          TIMESTAMPTZ,
      de_identified          BOOLEAN NOT NULL DEFAULT TRUE,
      care_value_index       INT NOT NULL,
      band                   TEXT NOT NULL,
      score_appropriateness  INT,
      score_efficiency       INT,
      score_safety           INT,
      score_cost             INT,
      score_documentation    INT,
      score_patient_centred  INT,
      completeness_pct       INT,
      n_findings             INT NOT NULL DEFAULT 0,
      n_low_value            INT NOT NULL DEFAULT 0,
      n_context_dependent    INT NOT NULL DEFAULT 0,
      findings               JSONB,
      suggestions            JSONB,
      billed_total           NUMERIC,
      engine_version         TEXT NOT NULL DEFAULT 'ipd-discharge-audit/0.1',
      model                  TEXT,
      trace_id               TEXT
    )`;
    steps.create_table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ipd_discharge_audits_doc_engine_uq ON ipd_discharge_audits (document_id, engine_version)`;
    steps.unique_doc_engine = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS ipd_discharge_audits_discharged_idx ON ipd_discharge_audits (discharged_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_discharge_audits_speciality_idx ON ipd_discharge_audits (speciality)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_discharge_audits_band_idx ON ipd_discharge_audits (band)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_discharge_audits_ip_uid_idx ON ipd_discharge_audits (ip_uid)`;
    steps.indexes = 'ok';
    // 0014 — full de-identified report JSON (powers the report page render) + per-finding triage
    await sql`ALTER TABLE ipd_discharge_audits ADD COLUMN IF NOT EXISTS report JSONB`;
    steps.report_column = 'ok';
    await sql`CREATE TABLE IF NOT EXISTS ipd_audit_feedback (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source   TEXT NOT NULL DEFAULT 'standalone',
      audit_id     UUID NOT NULL,
      finding_ref  TEXT,
      verdict      TEXT NOT NULL,
      note         TEXT
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_audit_feedback_audit_idx ON ipd_audit_feedback (audit_id)`;
    steps.feedback_table = 'ok';
    const counts = (await sql`SELECT count(*)::int AS n FROM ipd_discharge_audits`) as Array<{ n: number }>;
    steps.rows = String(counts[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
