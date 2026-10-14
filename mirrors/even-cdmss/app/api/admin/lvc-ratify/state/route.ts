/**
 * app/api/admin/lvc-ratify/state/route.ts — LVC RULEBOOK REPAIR PRD v1.1 §3.5, 25 Aug 2026.
 *
 * READ-ONLY. The record set plus the progress derived from the LIVE rulebook and the ledger.
 * It writes nothing and has no POST.
 *
 * This is what makes the sitting resumable (§6.13): the screen holds no progress of its own, so a
 * reload re-derives everything from the database. There is no session, no cursor and no
 * localStorage anywhere in this path — closing the browser mid-sitting loses nothing.
 *
 * FAIL-SAFE: every read degrades independently inside loadSurfaceState. An unreadable ledger or an
 * unreadable finding count still renders the screen and says so in `notes`; only a genuinely
 * unreadable rulebook disables accepting, and even that returns a rendered 200 rather than a 500.
 *
 *   GET /api/admin/lvc-ratify/state              → the Phase 1 merge record set
 *   GET /api/admin/lvc-ratify/state?set=<key>    → any other record set (D-21)
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { loadSurfaceState, listRecordSets } from '@/lib/lvc-ratify-surface-core';
import type { SqlRunner } from '@/lib/lvc-rule-merge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;   // the lifetime fire count unnests the audit table's findings

const run = sql as unknown as SqlRunner;

export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }

  try {
    const state = await loadSurfaceState(run, req.nextUrl.searchParams.get('set'));
    return NextResponse.json({ ok: true, sets: listRecordSets(), ...state });
  } catch (e) {
    // loadSurfaceState catches its own reads, so reaching here means something structural. Report
    // it as JSON with accepting disabled rather than throwing a 500 at a clinician mid-sitting.
    return NextResponse.json({
      ok: false,
      error: `surface state unavailable: ${String((e as Error).message).slice(0, 300)}`,
      rulebook_available: false,
      rules: [],
    }, { status: 200 });
  }
}
