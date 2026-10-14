/**
 * POST /api/care/lvc/retire — retire an active/contested assertion → status='retired' + hide its
 * embedded chunk (mksap_chunks.visible=false stops grounding, keeps provenance). Body {id}. Manual only
 * (no auto-retire). CDMSS-EVEN-LVC-ADJUDICATION §6. Flag-gated; care/admin auth; fail-safe.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { retireAssertion } from '@/lib/even-lvc';
import { bumpEpoch } from '@/lib/even-ground';

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
  const result = await retireAssertion(String(body.id ?? ''));
  // Retiring an assertion changes the grounding set (its citations now display-filter out) → bump the
  // epoch so the worker re-sweeps newest-first (best-effort; never affects the retire result).
  if (result.ok) await bumpEpoch();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
