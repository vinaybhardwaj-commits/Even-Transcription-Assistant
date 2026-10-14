/**
 * POST /api/care/lvc/generate  — run the Kimi LVC-assertion generation pass (CDMSS-EVEN-LVC-ADJUDICATION
 * §5). ?auto=1 = the idempotent nightly-cron tick (skips if a run is in progress or no new low-value
 * findings since the last ok run). All logic + the governed model call live in lib/even-lvc.ts.
 *
 * FLAGGED OFF by default: needs LVC_ADJUDICATION_ENABLED=1 (+ CCB_ENABLED=1). Auth: Authorization
 * Bearer CRON_SECRET, a care-unlock cookie, or an admin cookie. NEVER a 500 from a
 * generation failure — an OpenRouter error returns status='error', 0 candidates (PRD §1.3).
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runGeneration } from '@/lib/even-lvc';
import { cronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function enabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_ADJUDICATION_ENABLED === '1'; }

async function authed(req: NextRequest): Promise<boolean> {
  if (cronAuthorized(req)) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const auto = req.nextUrl.searchParams.get('auto') === '1';
  const result = await runGeneration({ trigger: auto ? 'cron' : 'manual', auto });
  return NextResponse.json(result);   // always 200; result.status ∈ ok|error|skipped
}

// Allow the Vercel cron GET too (crons issue GET); mirrors the ?auto tick shape.
export async function GET(req: NextRequest) { return POST(req); }
