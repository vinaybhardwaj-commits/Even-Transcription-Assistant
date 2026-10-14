export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { ensureProvenanceSnapshotTable } from '@/lib/provenance-tier';

/** One-click, idempotent: create provenance_tier_snapshots (append-only daily rollup, counts only —
 *  PRD CDMSS-PROVENANCE-TIER-LEDGER L6). Admin or ?token=ADMIN_TOKEN. */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try { await ensureProvenanceSnapshotTable(); return NextResponse.json({ ok: true, migrated: 'provenance_tier_snapshots' }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
