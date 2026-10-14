export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureTickTable } from '@/lib/mini-backfill';

/** One-click, idempotent: create mini_backfill_ticks (the pipeline state timeline).
 *  Admin session or ?token=ADMIN_TOKEN. (The autopilot also self-creates it on first tick.) */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureTickTable(); return NextResponse.json({ ok: true, migrated: 'mini_backfill_ticks' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
