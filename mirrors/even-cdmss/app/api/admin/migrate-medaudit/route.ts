import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the Medication Chart Audit schema. Idempotent. Mirrors migrations/0004_med_audit.sql.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS formulary (
      id BIGSERIAL PRIMARY KEY,
      item_code TEXT, brand TEXT, generic TEXT NOT NULL, generic_canon TEXT NOT NULL,
      dosage_form TEXT, major_grouping TEXT, minor_grouping TEXT, manufacturer TEXT,
      schedule_dc TEXT, schedule_ip TEXT, dept_primary TEXT, dept_secondary TEXT,
      high_risk BOOLEAN DEFAULT FALSE, lasa TEXT, ved TEXT,
      audit_category TEXT, restricted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS formulary_canon_idx ON formulary (generic_canon)`;
    await sql`CREATE INDEX IF NOT EXISTS formulary_category_idx ON formulary (audit_category)`;
    await sql`CREATE INDEX IF NOT EXISTS formulary_restricted_idx ON formulary (restricted) WHERE restricted`;
    steps.formulary = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS med_audit_session (
      id BIGSERIAL PRIMARY KEY, uhid TEXT, auditor TEXT, audit_date DATE, location TEXT,
      admission_date DATE, consultant TEXT, allergies_documented TEXT,
      known_allergies JSONB DEFAULT '[]'::jsonb, status TEXT DEFAULT 'final',
      app_source TEXT DEFAULT 'medaudit', created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS med_audit_session_uhid_idx ON med_audit_session (uhid, created_at DESC)`;
    steps.med_audit_session = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS med_audit_drug (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT REFERENCES med_audit_session(id) ON DELETE CASCADE,
      position INT, name TEXT NOT NULL, category TEXT, dose TEXT, frequency TEXT, route TEXT,
      reserve BOOLEAN DEFAULT FALSE, high_alert BOOLEAN DEFAULT FALSE,
      formulary_id BIGINT REFERENCES formulary(id) ON DELETE SET NULL
    )`;
    await sql`CREATE INDEX IF NOT EXISTS med_audit_drug_session_idx ON med_audit_drug (session_id)`;
    steps.med_audit_drug = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS med_audit_finding (
      id BIGSERIAL PRIMARY KEY,
      drug_id BIGINT REFERENCES med_audit_drug(id) ON DELETE CASCADE,
      param_no INT NOT NULL, param_label TEXT, status TEXT NOT NULL, ncc_merp CHAR(1), note TEXT
    )`;
    await sql`CREATE INDEX IF NOT EXISTS med_audit_finding_drug_idx ON med_audit_finding (drug_id)`;
    steps.med_audit_finding = 'ok';

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
