import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the Appropriateness / Low-Value-Care schema (lvc_recommendations).
// Idempotent. Mirrors migrations/0005_choosing_wisely.sql.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS lvc_recommendations (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      society TEXT NOT NULL,
      specialty TEXT,
      statement TEXT NOT NULL,
      precondition TEXT,
      action_type TEXT,
      consider_instead TEXT,
      rationale TEXT,
      keywords TEXT[] DEFAULT '{}',
      citation_doi TEXT,
      citation_pmid TEXT,
      citation_url TEXT,
      source_release_year INT,
      status TEXT DEFAULT 'active',
      chunk_text_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    steps.lvc_recommendations = 'ok';

    await sql`CREATE INDEX IF NOT EXISTS lvc_region_idx ON lvc_recommendations (region)`;
    await sql`CREATE INDEX IF NOT EXISTS lvc_specialty_idx ON lvc_recommendations (specialty)`;
    await sql`CREATE INDEX IF NOT EXISTS lvc_action_type_idx ON lvc_recommendations (action_type)`;
    await sql`CREATE INDEX IF NOT EXISTS lvc_status_idx ON lvc_recommendations (status)`;
    await sql`CREATE INDEX IF NOT EXISTS lvc_keywords_gin ON lvc_recommendations USING GIN (keywords)`;
    steps.indexes = 'ok';

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
