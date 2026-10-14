export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureLvpDecorationsTable } from '@/lib/lvp-operator';

/** One-click, idempotent: create lvp_decorations (migration 0040). Admin session or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureLvpDecorationsTable(); return NextResponse.json({ ok: true, migrated: 'lvp_decorations' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
