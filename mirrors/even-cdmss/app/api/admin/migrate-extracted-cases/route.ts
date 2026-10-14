import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { DOC_EXTRACT_VERSION, extractStoreCounts } from '@/lib/discharge-extract-store';

export const runtime = 'nodejs';

// Creates discharge_extracted_cases — the SHARED de-identified extracted-case store
// (Readmission Phase 1.5 substrate addendum §5, decision 7.1). Additive + idempotent;
// mirrors migrate-readmissions. Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session.
//
// One row per (document_id, extraction_version). Written by the IPD discharge audit on
// its cron (an additive best-effort write) and by the readmission agent when it has to
// extract a document the store does not hold yet; read by both.
//
// PHI (§5a, V-approved): extracted_json is the DE-IDENTIFIED ExtractedCase — no patient
// name, no UHID. ip_uid/member_id/document_id are link-back keys only and are never sent
// to a model. Same posture as ipd_discharge_audits.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS discharge_extracted_cases (
      document_id         TEXT NOT NULL,
      extraction_version  TEXT NOT NULL DEFAULT 'doc-extract/1',
      ip_uid              TEXT,
      member_id           TEXT,
      extracted_json      JSONB NOT NULL,
      extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      trace_id            TEXT,
      PRIMARY KEY (document_id, extraction_version)
    )`;
    steps.create_table = 'ok';
    // Idempotent re-run safety for a table created by an earlier shape of this route.
    await sql`ALTER TABLE discharge_extracted_cases ADD COLUMN IF NOT EXISTS ip_uid TEXT`;
    await sql`ALTER TABLE discharge_extracted_cases ADD COLUMN IF NOT EXISTS member_id TEXT`;
    await sql`ALTER TABLE discharge_extracted_cases ADD COLUMN IF NOT EXISTS trace_id TEXT`;
    steps.columns = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS discharge_extracted_cases_ip_uid_idx ON discharge_extracted_cases (ip_uid)`;
    await sql`CREATE INDEX IF NOT EXISTS discharge_extracted_cases_extracted_at_idx ON discharge_extracted_cases (extracted_at DESC)`;
    steps.indexes = 'ok';
    const counts = await extractStoreCounts();
    steps.rows = String(counts.total);
    steps.rows_at_current_version = String(counts.atVersion);
    return NextResponse.json({ ok: true, extractionVersion: DOC_EXTRACT_VERSION, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
