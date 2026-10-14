import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the two CCB v2 P1 cache tables. Idempotent. Mirrors migrations/0010_ccb_cache.sql.
// Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session cookie — one-click from
// the dashboard without handling the token (verbatim copy of the migrate-ccb pattern).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS ccb_member_snapshot (
      individual_uid TEXT PRIMARY KEY,
      snapshot       JSONB NOT NULL,
      source         TEXT NOT NULL DEFAULT 'live',
      refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    steps.member_snapshot = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS ccb_member_snapshot_refreshed_idx ON ccb_member_snapshot (refreshed_at DESC)`;
    steps.member_snapshot_idx = 'ok';

    await sql`CREATE TABLE IF NOT EXISTS ccb_doc_extract (
      doc_sha    TEXT PRIMARY KEY,
      extract    JSONB NOT NULL,
      model      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    steps.doc_extract = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS ccb_doc_extract_created_idx ON ccb_doc_extract (created_at DESC)`;
    steps.doc_extract_idx = 'ok';

    const snap = (await sql`SELECT count(*)::int AS n FROM ccb_member_snapshot`) as Array<{ n: number }>;
    const ext = (await sql`SELECT count(*)::int AS n FROM ccb_doc_extract`) as Array<{ n: number }>;
    steps.snapshots = String(snap[0]?.n ?? 0);
    steps.extracts = String(ext[0]?.n ?? 0);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
