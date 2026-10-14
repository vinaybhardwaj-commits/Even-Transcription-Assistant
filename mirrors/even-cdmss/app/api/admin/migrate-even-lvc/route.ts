import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Applies migrations/0018_even_lvc_assertions.sql (CDMSS-EVEN-LVC-ADJUDICATION §3). Idempotent
// (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Auth: ADMIN_TOKEN (Bearer/?token=) OR a logged-in admin
// session cookie — so V can run it one-click from the browser (cookie auth, no token in a terminal).
// MUST run BEFORE the deploy that inserts the new opd_audit_feedback columns (the column-add gotcha).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS even_lvc_assertions (
      id             TEXT PRIMARY KEY,
      artifact_type  TEXT NOT NULL DEFAULT 'opd_note',
      lvc_category   TEXT NOT NULL,
      assertion_text TEXT NOT NULL,
      rationale      TEXT,
      supporting     JSONB NOT NULL DEFAULT '[]',
      status         TEXT NOT NULL DEFAULT 'pending',
      version        INT  NOT NULL DEFAULT 1,
      generated_by   TEXT,
      ratified_by    TEXT,
      ratified_at    TIMESTAMPTZ,
      own_cases      BOOLEAN NOT NULL DEFAULT false,
      contest_count  INT NOT NULL DEFAULT 0,
      chunk_item_number TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS even_lvc_status_idx   ON even_lvc_assertions (status)`;
    await sql`CREATE INDEX IF NOT EXISTS even_lvc_category_idx ON even_lvc_assertions (lvc_category)`;
    steps.assertions = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS even_lvc_gen_runs (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at  TIMESTAMPTZ,
      status       TEXT NOT NULL DEFAULT 'running',
      n_candidates INT DEFAULT 0,
      trigger      TEXT,
      error        TEXT
    )`;
    steps.gen_runs = 'ok';

    // §3.3 — additive contest tag on opd_audit_feedback (run BEFORE the deploy that inserts them).
    await sql`ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS assertion_id      TEXT`;
    await sql`ALTER TABLE opd_audit_feedback ADD COLUMN IF NOT EXISTS assertion_version INT`;
    await sql`CREATE INDEX IF NOT EXISTS opd_audit_feedback_assertion_idx ON opd_audit_feedback (assertion_id)`;
    steps.feedback_contest = 'ok';

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
