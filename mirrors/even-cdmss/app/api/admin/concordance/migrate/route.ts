import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the capture-and-wall concordance_runs registry (de-identified feature vectors).
// Idempotent. No identifiers, no per-patient key — Track-2 registry only.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS concordance_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      analytes TEXT[] DEFAULT '{}',
      verdict TEXT,
      branch TEXT,
      confidence TEXT,
      asked_count INT DEFAULT 0,
      unknown_count INT DEFAULT 0,
      who_report INT DEFAULT 0,
      who_you INT DEFAULT 0,
      who_lab INT DEFAULT 0,
      age_band TEXT,
      sex TEXT,
      mode TEXT,
      engine TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    steps.concordance_runs = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS concordance_runs_created_idx ON concordance_runs (created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS concordance_runs_verdict_idx ON concordance_runs (verdict)`;
    await sql`CREATE INDEX IF NOT EXISTS concordance_runs_analytes_gin ON concordance_runs USING GIN (analytes)`;
    steps.indexes = 'ok';
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
