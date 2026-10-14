import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { listConcordanceRuns, runAggregates } from '@/lib/concordance-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ADMIN-ONLY registry read (Track-2 calibration). This is the ONLY read path for
// concordance_runs — the operational surface has none (capture-and-wall).
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '100', 10) || 100, 500);
  const offset = Math.max(parseInt(req.nextUrl.searchParams.get('offset') || '0', 10) || 0, 0);
  try {
    const [runs, aggregates] = await Promise.all([listConcordanceRuns(limit, offset), runAggregates()]);
    return NextResponse.json({ ok: true, aggregates, runs });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
