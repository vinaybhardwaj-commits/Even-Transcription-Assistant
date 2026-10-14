/**
 * POST /api/care/patterns/hide — the one CM action on the shelf (LVP-L1 kickoff §4.5/§6).
 * Body { pattern_id, op: 'hide' | 'unhide', reason? }. Appends ONE row to lvp_hidden
 * (append-only, latest wins — §4.5); returns the new shelf state. A failure returns an
 * error with no partial write (the append is a single INSERT).
 *
 * Hide never touches Triage quieting, opd_audit_triage, opd_gov_signal, MemberState,
 * mksap_chunks, or any score.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { appendHideRow, loadShelf } from '@/lib/lvp-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.LVC_PATTERNS_ENABLED === '1';
}

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await isCareUnlocked().catch(() => false))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const patternId = typeof body.pattern_id === 'string' ? body.pattern_id.trim() : '';
  const op = body.op === 'hide' || body.op === 'unhide' ? body.op : null;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
  if (!patternId || !patternId.startsWith('pattern:')) {
    return NextResponse.json({ ok: false, error: 'pattern_id required (pattern:{concept_id})' }, { status: 400 });
  }
  if (!op) return NextResponse.json({ ok: false, error: "op must be 'hide' or 'unhide'" }, { status: 400 });

  try {
    await appendHideRow(patternId, op, reason);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
  // Best-effort re-read for the new state; the append above is already durable.
  try {
    const shelf = await loadShelf();
    return NextResponse.json({ ok: true, ...shelf });
  } catch {
    return NextResponse.json({ ok: true, suggested: [], hidden: [], degraded: true });
  }
}
