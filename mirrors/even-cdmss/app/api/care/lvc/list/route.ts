/**
 * GET /api/care/lvc/list — the assertion board (CDMSS-EVEN-LVC-ADJUDICATION §6): {pending, active,
 * contested, retired, rejected} + a live pending count for the /care card badge + the ratifier roster.
 * Recomputes contest counts + applies the active→contested flip (in lib/even-lvc.loadBoard). Fail-safe:
 * any DB error degrades to an empty board, never a 500. Flag-gated; care/admin auth.
 */
import { NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { getSettings } from '@/lib/mini-backfill';
import { FALLBACK_ROSTER } from '@/lib/review-stats-core';
import { loadBoard } from '@/lib/even-lvc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_ADJUDICATION_ENABLED === '1'; }
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

async function roster(): Promise<string[]> {
  try {
    const s = await getSettings(['review_roster']).catch(() => ({} as Record<string, string>));
    const j = JSON.parse(s.review_roster || '');
    if (Array.isArray(j)) { const l = j.map((x) => String(x).trim()).filter(Boolean); if (l.length) return l; }
  } catch { /* fall through */ }
  return FALLBACK_ROSTER;
}

export async function GET() {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const [board, rosterList] = await Promise.all([loadBoard(), roster()]);
  return NextResponse.json({ ok: true, roster: rosterList, ...board });
}
