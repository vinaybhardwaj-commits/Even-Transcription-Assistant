/**
 * POST /api/care/lvc/ratify — ratify (or edit-and-ratify) a candidate assertion → active + embed into
 * mksap_chunks (CDMSS-EVEN-LVC-ADJUDICATION §6). Body {id, ratified_by (roster identity), assertion_text?}.
 * Computes own_cases (honest self-ratification signal; rarely true). Flag-gated; care/admin auth.
 * Fail-safe: a DB/embed error returns {ok:false, error}, never wrong data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { ratifyAssertion } from '@/lib/even-lvc';
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
  const id = String(body.id ?? '').trim();
  const ratified_by = String(body.ratified_by ?? '').trim();
  const assertion_text = typeof body.assertion_text === 'string' ? body.assertion_text : undefined;
  const result = await ratifyAssertion({ id, ratified_by, assertion_text });
  // A new/edited active assertion changes the grounding set → bump the epoch so the worker re-sweeps
  // newest-first (best-effort; never affects the ratify result).
  if (result.ok) await bumpEpoch();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
