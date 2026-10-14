import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { recomputeOutcomes } from '@/lib/care-call-store';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Re-derives `payload.derived` + `escalation` from the immutable raw `responses` (mapping improved),
// stamps the current ask-set version. NEVER modifies raw responses. Admin only.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const limit = Math.max(1, Math.min(5000, parseInt(req.nextUrl.searchParams.get('limit') || '500', 10) || 500));
  try {
    const updated = await recomputeOutcomes(limit);
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
