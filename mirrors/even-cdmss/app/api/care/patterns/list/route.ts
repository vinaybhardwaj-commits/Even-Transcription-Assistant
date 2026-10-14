/**
 * GET /api/care/patterns/list — the Low-value patterns shelf (LVP-L1 kickoff §6).
 * { suggested, hidden }: Suggested computed ON READ from concept stamps (overuse-first,
 * floor 5, cap 23, hide-filtered), Hidden = latest-wins lvp_hidden rows.
 *
 * READ-ONLY — no write statement of any kind in this path (the /care/lvc list
 * route's GET-that-writes is the anti-pattern this route must never copy).
 * Fail-safe: any data-layer error degrades to an EMPTY shelf with degraded:true,
 * never a 500, never wrong data.
 */
import { NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { loadShelf } from '@/lib/lvp-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.LVC_PATTERNS_ENABLED === '1';
}

export async function GET() {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await isCareUnlocked().catch(() => false))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const shelf = await loadShelf();
    return NextResponse.json({ ok: true, ...shelf });
  } catch {
    return NextResponse.json({ ok: true, suggested: [], hidden: [], degraded: true });
  }
}
