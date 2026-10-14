import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Creates the appropriateness_runs research-retention table. Idempotent.
// Mirrors migrations/0006_appropriateness_runs.sql.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS appropriateness_runs (
      id            TEXT PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mode          TEXT NOT NULL CHECK (mode IN ('check','pathway','audit')),
      app_source    TEXT NOT NULL DEFAULT 'standalone',
      scenario      TEXT,
      doc_type      TEXT,
      summary       TEXT,
      n_sources     INT NOT NULL DEFAULT 0,
      n_findings    INT NOT NULL DEFAULT 0,
      input         JSONB,
      output        JSONB NOT NULL,
      de_identified BOOLEAN NOT NULL DEFAULT TRUE
    )`;
    steps.appropriateness_runs = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS appropriateness_runs_mode_idx ON appropriateness_runs (mode, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS appropriateness_runs_created_idx ON appropriateness_runs (created_at DESC)`;
    steps.indexes = 'ok';
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
