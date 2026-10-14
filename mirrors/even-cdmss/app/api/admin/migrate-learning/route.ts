import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the learning-loop review queue (LL.1). Idempotent. Auth: ADMIN_TOKEN OR admin cookie
// (one-click from the dashboard, like the OPD-audit migration).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS learning_proposals (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source         TEXT NOT NULL DEFAULT 'standalone',
      type               TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'proposed',
      cluster_key        TEXT NOT NULL,
      title              TEXT,
      payload            JSONB,
      evidence           JSONB,
      provenance         JSONB,
      confidence         REAL,
      n_support          INT,
      suggested_reviewer TEXT,
      reviewed_by        TEXT,
      reviewed_at        TIMESTAMPTZ,
      review_note        TEXT
    )`;
    steps.table = 'ok';
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS learning_proposals_cluster_uq ON learning_proposals (type, cluster_key)`;
    await sql`CREATE INDEX IF NOT EXISTS learning_proposals_status_idx ON learning_proposals (status, created_at DESC)`;
    steps.indexes = 'ok';
    // LL.2b — track which lvc_recommendations row an approved proposal created.
    await sql`ALTER TABLE learning_proposals ADD COLUMN IF NOT EXISTS applied_ref TEXT`;
    steps.applied_ref = 'ok';
    // LL.2b (decision #5) — tag lvc_recommendations rows by origin + licence so mined (original)
    // rules go live while any future licensed Choosing-Wisely content can be gated. The live
    // matcher's SELECT does NOT reference these columns, so adding them can't affect Right Care.
    await sql`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS provenance TEXT`;
    await sql`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS license_status TEXT`;
    steps.lvc_columns = 'ok';
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
