import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the Consensus-gold (#7) union-adjudication tables. Idempotent. Mirrors
// migrations/0015_ipd_gold_union.sql. Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS ipd_gold_union_candidates (
      id              TEXT PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source      TEXT NOT NULL DEFAULT 'standalone',
      gold_version    TEXT NOT NULL,
      case_id         TEXT NOT NULL,
      ip_uid          TEXT,
      finding_text    TEXT NOT NULL,
      in_gold         BOOLEAN NOT NULL,
      k5_count        INT NOT NULL,
      cluster_size    INT NOT NULL DEFAULT 1,
      cluster_members JSONB,
      ord             INT NOT NULL DEFAULT 0
    )`;
    steps.candidates = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS ipd_gold_union_candidates_case_idx ON ipd_gold_union_candidates (case_id)`;
    await sql`CREATE TABLE IF NOT EXISTS ipd_gold_adjudication (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source   TEXT NOT NULL DEFAULT 'standalone',
      candidate_id TEXT NOT NULL,
      case_id      TEXT NOT NULL,
      verdict      TEXT NOT NULL,
      note         TEXT
    )`;
    steps.adjudication = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS ipd_gold_adjudication_candidate_idx ON ipd_gold_adjudication (candidate_id)`;
    await sql`CREATE INDEX IF NOT EXISTS ipd_gold_adjudication_case_idx ON ipd_gold_adjudication (case_id)`;
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
