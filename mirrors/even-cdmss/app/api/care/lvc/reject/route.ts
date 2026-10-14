/**
 * POST /api/care/lvc/reject — mark a candidate assertion 'rejected' (kept for dedup memory; NOT
 * embedded). Body {id}. CDMSS-EVEN-LVC-ADJUDICATION §6. Flag-gated; care/admin auth; fail-safe.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { rejectAssertion } from '@/lib/even-lvc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_ADJUDICATION_ENABLED === '1'; }
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* ignore */ }
  const result = await rejectAssertion(String(body.id ?? ''));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
