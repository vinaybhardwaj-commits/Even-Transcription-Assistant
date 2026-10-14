import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { migrateAdhocSets } from '@/lib/proms/adhoc-store';

export const runtime = 'nodejs';

// Creates adhoc_sets + adhoc_promotions + indexes (PROMs 0.2b-2 Tier-3). Idempotent. Admin only
// (ADMIN_TOKEN or an admin session cookie), mirroring migrate-proms. Run after deploy, before TIER3_ENABLED.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  try {
    const steps = await migrateAdhocSets();
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
