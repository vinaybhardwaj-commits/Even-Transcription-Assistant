import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

// Creates the episode_recon_ratings table (EpisodeState #4 SL5). Idempotent. Mirrors
// migrations/0017_episode_recon_ratings.sql. Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS episode_recon_ratings (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source  TEXT NOT NULL DEFAULT 'standalone',
      document_id TEXT NOT NULL,
      ip_uid      TEXT,
      version     TEXT NOT NULL,
      phase       TEXT NOT NULL,
      fact_ref    TEXT,
      verdict     TEXT NOT NULL,
      note        TEXT
    )`;
    steps.table = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS episode_recon_ratings_doc_idx ON episode_recon_ratings (document_id)`;
    steps.index = 'ok';
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
