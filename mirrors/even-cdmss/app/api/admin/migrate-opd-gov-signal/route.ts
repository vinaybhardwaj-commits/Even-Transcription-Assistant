export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureGovSignalTables } from '@/lib/opd-gov-signal-store';

/** One-click, idempotent: create opd_gov_signal + opd_gov_signal_event. Admin session or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureGovSignalTables(); return NextResponse.json({ ok: true, migrated: 'opd_gov_signal + opd_gov_signal_event' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
