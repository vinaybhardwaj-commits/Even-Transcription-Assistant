import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { migrateCareCall } from '@/lib/care-call-store';

export const runtime = 'nodejs';

// Creates care_call_outcomes + indexes (Care-Call Capture). Idempotent. Admin only (ADMIN_TOKEN or
// an admin session cookie), mirroring the OPD/CCB migrate routes.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  try {
    const steps = await migrateCareCall();
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
