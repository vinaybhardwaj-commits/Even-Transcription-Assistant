export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureSuppressionTable } from '@/lib/audit-suppression-store';

/** One-click, idempotent: create/extend audit_suppression (quieting: approved_by/approved_at/status
 *  + legacy-row status backfill), quieting_policy_log, and opd_note_audits.quieting_gen.
 *  Admin or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureSuppressionTable(); return NextResponse.json({ ok: true, migrated: 'audit_suppression + quieting (approved_by/approved_at/status, quieting_policy_log, opd_note_audits.quieting_gen)' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
