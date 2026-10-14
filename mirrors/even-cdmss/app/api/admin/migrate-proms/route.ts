import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { migrateProms } from '@/lib/proms/store';

export const runtime = 'nodejs';

// Creates prom_series + prom_responses + indexes (PROMs 0.2a-2). Idempotent. Admin only (ADMIN_TOKEN
// or an admin session cookie), mirroring the OPD/CCB/Care-Call migrate routes. Run after deploy.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  try {
    const steps = await migrateProms();
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
