/**
 * GET/POST /api/admin/wm3-join — run one bounded WM3 join.
 *
 * GET  ?auto=1  = the unattended cron tick, every 6h via vercel.json, one hour after the shadow
 *                 sweep so the events it opens over are already written. Cron-auth mirrors
 *                 /api/admin/shadow-sweep EXACTLY: the Vercel cron header, a CRON_SECRET
 *                 Bearer/?secret, or an admin session. All three phases.
 * GET           = status only. Reports the versions and caps without writing.
 * POST          = a manual run. Auth: ADMIN_TOKEN (Bearer / ?token=) or an admin session.
 *                 `{ mode:'backfill', limit:50 }` runs phase 1 only — the first runs of the join
 *                 are backfills, and everything they open is `reconstructed` by construction.
 *                 `{ mode:'retry_failed' }` (or `?retry_failed=1`) re-captures the O_after
 *                 snapshots that were an outage.
 *
 * ⚠️ THIS ROUTE WRITES PHI. cognition_snapshots holds whole member-state snapshots against a plain
 * individual_uid. Nothing it writes is readable by the Lab research scope, and no doctor-facing
 * surface reads either table.
 *
 * Never 500s on a data problem: `runJoinSweep` returns `{ ok:false, error }` and this route
 * surfaces that as a 200 with the failure named, so a cron tick reports rather than alerts. A 500
 * is reserved for the route itself being broken.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import {
  runJoinSweep, runJoinBackfill, runJoinRetryFailed,
  JOIN_TRIGGER_KIND, JOIN_MICROWORLD, JOIN_Y_KIND, Y_HORIZON_DAYS,
  PHASE1_CAP, PHASE2_CAP, PHASE3_CAP, BACKFILL_CAP, PACING_MS, SWEEP_BUDGET_MS,
} from '@/lib/cognition/join-sweep';
import { BURDEN_POLICY_VERSION, JOIN_SCHEMA_VERSION } from '@/lib/cognition/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const META = {
  phiWarning: 'Writes PHI (cognition_snapshots, cognition_triples). Not readable by the Lab scope.',
  triggerKind: JOIN_TRIGGER_KIND,
  microworld: JOIN_MICROWORLD,
  yKind: JOIN_Y_KIND,
  horizonDays: Y_HORIZON_DAYS,
  caps: { phase1: PHASE1_CAP, phase2: PHASE2_CAP, phase3: PHASE3_CAP, backfill: BACKFILL_CAP, pacingMs: PACING_MS, budgetMs: SWEEP_BUDGET_MS },
  policyVersion: BURDEN_POLICY_VERSION,
  schemaVersion: JOIN_SCHEMA_VERSION,
};

/** Manual auth: ADMIN_TOKEN or an admin session cookie. */
async function authed(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
}

/** Cron-caller auth for ?auto=1 — the shadow sweep's pattern, unchanged. */
async function cronAuthed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('auto') === '1') {
    if (!(await cronAuthed(req))) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    const result = await runJoinSweep();
    return NextResponse.json({ ...META, auto: true, ...result });
  }
  const denied = await authed(req);
  if (denied) return denied;
  return NextResponse.json({ ...META, status: 'ready — POST to run one batch' });
}

export async function POST(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }
  const mode = String(body.mode ?? '');
  const retryFlag = req.nextUrl.searchParams.get('retry_failed') === '1';

  if (mode === 'backfill') {
    const limit = Number.isInteger(body.limit) ? (body.limit as number) : BACKFILL_CAP;
    return NextResponse.json({ ...META, ...(await runJoinBackfill(limit)) });
  }
  if (mode === 'retry_failed' || retryFlag) {
    return NextResponse.json({ ...META, ...(await runJoinRetryFailed()) });
  }
  return NextResponse.json({ ...META, ...(await runJoinSweep()) });
}
