import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS digest_runs (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT REFERENCES user_profiles(id) ON DELETE CASCADE,
      generated_at  TIMESTAMPTZ DEFAULT NOW(),
      window_start  TIMESTAMPTZ NOT NULL,
      window_end    TIMESTAMPTZ NOT NULL,
      summary       TEXT,
      themes        JSONB DEFAULT '[]'::jsonb,
      gaps          JSONB DEFAULT '[]'::jsonb,
      flashcard_ids BIGINT[] DEFAULT '{}'::BIGINT[],
      query_count   INT
    )`;
    steps.digest_runs = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS digest_runs_user_idx ON digest_runs (user_id, generated_at DESC)`;
    steps.digest_runs_idx = 'ok';
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
