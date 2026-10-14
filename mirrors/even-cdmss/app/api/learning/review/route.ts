export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { reviewProposal } from '@/lib/learning';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';

// Approve / reject a learning proposal. Sets STATUS ONLY — applying an approved rule into
// lvc_recommendations (and thereby the live appropriateness engine) is the separate, gated
// LL.2b step (after matcher tests). Auth: ADMIN_TOKEN OR admin session cookie.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const id = String(body.id ?? '').trim();
  const action = String(body.action ?? '');
  const reviewer = body.reviewer ? String(body.reviewer).trim().slice(0, 120) : null;
  const note = body.note ? String(body.note).trim().slice(0, 2000) : null;

  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  if (action !== 'approve' && action !== 'reject' && action !== 'harvest') return NextResponse.json({ error: 'action must be approve|reject|harvest' }, { status: 400 });

  try {
    const ok = await reviewProposal(id, action as 'approve' | 'reject' | 'harvest', reviewer, note);
    if (!ok) return NextResponse.json({ ok: false, error: 'not found or already reviewed' }, { status: 409 });
    return NextResponse.json({ ok: true, id, status: action === 'reject' ? 'rejected' : 'approved' });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
