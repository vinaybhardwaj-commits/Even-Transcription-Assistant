import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const runtime = 'nodejs';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// Applies migrations/0019_even_ground.sql (CDMSS-EVEN-LVC-GROUNDING-WORKER §3). Idempotent. Auth:
// ADMIN_TOKEN (Bearer/?token=) OR a logged-in admin session cookie — so V can run it one-click.
// finding_embeddings.embedding is created with the SAME nomic dim as mksap_chunks.embedding (detected
// live via format_type); falls back to an unbounded `vector` if detection fails (still accepts nomic).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const steps: Record<string, string> = {};
  try {
    await sql`CREATE TABLE IF NOT EXISTS even_ground_state (
      uid            TEXT PRIMARY KEY,
      grounded_epoch BIGINT NOT NULL DEFAULT 0,
      grounded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      n_citations    INT NOT NULL DEFAULT 0
    )`;
    await sql`CREATE INDEX IF NOT EXISTS even_ground_state_epoch_idx ON even_ground_state (grounded_epoch)`;
    steps.state = 'ok';

    // Detect the nomic embedding dim from mksap_chunks (format_type → 'vector(768)').
    let dim: number | null = null;
    try {
      const t = await run(
        `SELECT format_type(a.atttypid, a.atttypmod) AS t
         FROM pg_attribute a WHERE a.attrelid = 'mksap_chunks'::regclass AND a.attname = 'embedding'`, []);
      const m = String(t[0]?.t ?? '').match(/vector\((\d+)\)/i);
      if (m) dim = parseInt(m[1], 10);
    } catch { dim = null; }
    steps.nomic_dim = dim ? String(dim) : 'unbounded (detection failed)';
    const embType = dim && dim > 0 && dim <= 8000 ? `vector(${dim})` : 'vector';
    await run(`CREATE TABLE IF NOT EXISTS finding_embeddings (
      finding_key TEXT PRIMARY KEY,
      embedding   ${embType} NOT NULL,
      subject_hash TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, []);
    steps.finding_embeddings = `ok (${embType})`;

    await sql`CREATE TABLE IF NOT EXISTS even_ground_ticks (
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL,
      processed INT DEFAULT 0,
      citations_added INT DEFAULT 0,
      epoch BIGINT,
      note TEXT
    )`;
    await sql`CREATE INDEX IF NOT EXISTS even_ground_ticks_ts_idx ON even_ground_ticks (ts DESC)`;
    steps.ticks = 'ok';

    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
