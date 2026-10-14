export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureLabTables } from '@/lib/lab';

/** One-click, idempotent: create the lab_analyses table. Admin session or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureLabTables(); return NextResponse.json({ ok: true, migrated: 'lab_analyses' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
