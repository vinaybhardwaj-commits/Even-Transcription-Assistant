import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { migrateInquiry } from '@/lib/inquiry/inquiry-store';

export const runtime = 'nodejs';

// Creates inquiry_asksets + indexes (Inquiry engine, PRD §8). Idempotent. Admin only
// (ADMIN_TOKEN or an admin session cookie), mirroring migrate-care-call.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  try {
    const steps = await migrateInquiry();
    return NextResponse.json({ ok: true, steps });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
