/**
 * POST /api/care/lvc/generate  — run the Kimi LVC-assertion generation pass (CDMSS-EVEN-LVC-ADJUDICATION
 * §5). ?auto=1 = the idempotent nightly-cron tick (skips if a run is in progress or no new low-value
 * findings since the last ok run). All logic + the governed model call live in lib/even-lvc.ts.
 *
 * FLAGGED OFF by default: needs LVC_ADJUDICATION_ENABLED=1 (+ CCB_ENABLED=1). Auth: Vercel Cron
 * (x-vercel-cron) / Bearer CRON_SECRET / ?secret= / care-unlock / admin cookie. NEVER a 500 from a
 * generation failure — an OpenRouter error returns status='error', 0 candidates (PRD §1.3).
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runGeneration } from '@/lib/even-lvc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function enabled(): boolean { return process.env.CCB_ENABLED === '1' && process.env.LVC_ADJUDICATION_ENABLED === '1'; }

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
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
