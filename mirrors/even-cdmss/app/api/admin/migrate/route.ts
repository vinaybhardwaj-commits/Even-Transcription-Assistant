import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// One-shot, idempotent. v0.2 K1.1: add source column + index.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'mksap-19'`;
    steps.add_source_column = 'ok';
    await sql`UPDATE mksap_chunks SET source = 'mksap-19' WHERE source IS NULL`;
    steps.backfill_source = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS mksap_chunks_source_idx ON mksap_chunks (source)`;
    steps.source_index = 'ok';
    // Also add a tsvector column for hybrid retrieval (R1 prep)
    await sql`ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS text_tsv tsvector
              GENERATED ALWAYS AS (to_tsvector('english', text)) STORED`;
    steps.tsvector_column = 'ok';
    await sql`CREATE INDEX IF NOT EXISTS mksap_chunks_tsv_idx ON mksap_chunks USING gin (text_tsv)`;
    steps.tsv_gin_index = 'ok';
    // Verify
    const counts = (await sql`SELECT source, COUNT(*)::int AS n FROM mksap_chunks GROUP BY source`) as Array<{source: string; n: number}>;
    steps.counts = JSON.stringify(counts);
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
