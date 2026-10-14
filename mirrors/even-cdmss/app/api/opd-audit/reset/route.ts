export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// Destructive: deletes OPD audit rows so they can be re-audited with a corrected engine
// (e.g. after the extraction fix). Admin-token gated, POST only. The source notes in db13 are
// untouched — these are re-generatable derived audits. ?day=YYYY-MM-DD deletes one IST day;
// ?all=1 deletes every audit.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const p = req.nextUrl.searchParams;
  const day = p.get('day');
  const all = p.get('all') === '1';
  try {
    let rows: Record<string, unknown>[];
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      rows = await run(`DELETE FROM opd_note_audits WHERE app_source = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date RETURNING id`, [APP, day]);
    } else if (all) {
      rows = await run(`DELETE FROM opd_note_audits WHERE app_source = $1 RETURNING id`, [APP]);
    } else {
      return NextResponse.json({ ok: false, error: 'pass ?day=YYYY-MM-DD or ?all=1' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, deleted: rows.length, scope: day || 'all' });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
