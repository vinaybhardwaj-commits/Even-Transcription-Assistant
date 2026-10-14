/**
 * POST|GET /api/care/lvc/ground?auto=1 — the Even-LVC grounding worker tick (CDMSS-EVEN-LVC-GROUNDING
 * -WORKER §5). Deterministic, no-LLM: attaches "Even Adjudicated LVC" citations to matching low-value
 * findings, newest-first, epoch-aware. Additive + score-invariant + fail-safe. Always returns 200 with
 * {status, processed, citations_added, epoch}.
 *
 * FLAGGED OFF: needs CCB_ENABLED=1 AND LVC_GROUND_ENABLED=1. Auth: Authorization Bearer CRON_SECRET,
 * a care-unlock cookie, or an admin session — identical shape to the generate route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runGroundTick } from '@/lib/even-ground';
import { cronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function enabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_GROUND_ENABLED === '1'; }

async function authed(req: NextRequest): Promise<boolean> {
  if (cronAuthorized(req)) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, status: 'disabled', error: 'disabled' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const auto = req.nextUrl.searchParams.get('auto') === '1';
  const result = await runGroundTick({ trigger: auto ? 'cron' : 'manual' });
  return NextResponse.json({ ok: true, ...result });   // always 200; status ∈ ok|idle|paused|locked|error
}

export async function GET(req: NextRequest) { return POST(req); }   // Vercel cron issues GET
