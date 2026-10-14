import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the ccb_briefs table (CCB P1). Idempotent. Mirrors migrations/0008_ccb_briefs.sql.
// Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session cookie — one-click from
// the dashboard without handling the token (like the OPD migrate / Re-audit routes).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS ccb_briefs (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source            TEXT NOT NULL DEFAULT 'standalone',
      presc_uid             TEXT NOT NULL,
      individual_uid        TEXT NOT NULL,
      uhid                  TEXT,
      kx_encounter_id       TEXT,
      note_date             TIMESTAMPTZ,
      coverage              TEXT,
      engine_version        TEXT NOT NULL DEFAULT 'care-brief/0.1',
      priority              TEXT,
      pitch_allowed         BOOLEAN,
      n_findings            INT,
      n_cited               INT,
      citation_coverage_pct INT,
      distinct_sources      INT,
      envelope              JSONB NOT NULL,
      model                 TEXT,
      trace_id              TEXT,
      latency_ms            INT
    )`;
    steps.table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ccb_briefs_presc_engine_uq ON ccb_briefs (presc_uid, engine_version)`;
    await sql`CREATE INDEX IF NOT EXISTS ccb_briefs_note_date_idx ON ccb_briefs (note_date DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS ccb_briefs_individual_idx ON ccb_briefs (individual_uid)`;
    await sql`CREATE INDEX IF NOT EXISTS ccb_briefs_uhid_idx ON ccb_briefs (uhid)`;
    await sql`CREATE INDEX IF NOT EXISTS ccb_briefs_pitch_idx ON ccb_briefs (pitch_allowed)`;
    steps.indexes = 'ok';
    // P2.4 — doctor dimension for the conversion funnel's by-speciality breakdown.
    await sql`ALTER TABLE ccb_briefs ADD COLUMN IF NOT EXISTS doctor_uid TEXT`;
    await sql`ALTER TABLE ccb_briefs ADD COLUMN IF NOT EXISTS doctor_speciality TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS ccb_briefs_speciality_idx ON ccb_briefs (doctor_speciality)`;
    steps.doctor_dim = 'ok';
    const cols = (await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ccb_briefs'`) as Array<{ n: number }>;
    steps.columns = String(cols[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
