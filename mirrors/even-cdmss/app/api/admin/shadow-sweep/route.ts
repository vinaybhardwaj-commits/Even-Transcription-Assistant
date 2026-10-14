/**
 * GET/POST /api/admin/shadow-sweep — run one bounded WM1 shadow sweep.
 *
 * POST           = run one batch (≤200 events). Auth: ADMIN_TOKEN (Bearer / ?token=) or admin session.
 * GET  ?auto=1   = the unattended cron tick, every 6h via vercel.json. Cron-auth mirrors
 *                  complexity-backfill EXACTLY: the Vercel cron header, a CRON_SECRET Bearer/?secret,
 *                  or an admin session. That pattern already exists in this repo and is reused
 *                  verbatim rather than reinvented.
 *
 *                  THE SCHEDULE WAS EARNED, NOT ASSUMED. WM1 first shipped with NO cron: the sweep
 *                  was run by hand and its burden numbers read off the Shadow page. Only once those
 *                  numbers were verified live on 31 Aug 2026 — 398 eligible events, 31 would-asks,
 *                  one ask per 12.8 eligible against a ceiling of one per 10, every silence named —
 *                  was the vercel.json entry added. Manual first, cron second: an agent whose ask
 *                  rate nobody has looked at has no business waking up every six hours.
 * GET            = status only. Reports the policy/schema versions and budgets without writing.
 *
 * ⚠️ SHADOW ONLY — NO DOCTOR IS CONTACTED. This route writes rows to cognition_shadow_events and
 * does nothing else. It queues no ask, sends no notification, and changes no clinician-visible
 * surface. It exists so the burden policy can be MEASURED before anything is ever asked out loud.
 *
 * Never 500s on a data problem: `runShadowSweep` returns `{ ok:false, error }` and this route
 * surfaces that as a 200 with the failure named, so a cron tick reports rather than alerts. A 500 is
 * reserved for the route itself being broken.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runShadowSweep, SWEEP_BATCH, V0_TRIGGER_KIND } from '@/lib/cognition/shadow-sweep';
import { BURDEN_PER_ELIGIBLE, PER_DOCTOR_DAILY_CAP } from '@/lib/cognition/burden-policy';
import { BURDEN_POLICY_VERSION, COGNITION_SCHEMA_VERSION } from '@/lib/cognition/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const META = {
  shadowOnly: 'Shadow only — no doctor has seen or will see these.',
  triggerKind: V0_TRIGGER_KIND,
  batch: SWEEP_BATCH,
  policyVersion: BURDEN_POLICY_VERSION,
  schemaVersion: COGNITION_SCHEMA_VERSION,
  budgets: { perEligible: BURDEN_PER_ELIGIBLE, perDoctorDaily: PER_DOCTOR_DAILY_CAP },
};

/** Manual auth: ADMIN_TOKEN or an admin session cookie. */
async function authed(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
}

/** Cron-caller auth for ?auto=1 — the repo's existing pattern, unchanged. */
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
    const result = await runShadowSweep();
    return NextResponse.json({ ...META, auto: true, ...result });
  }
  const denied = await authed(req);
  if (denied) return denied;
  return NextResponse.json({ ...META, status: 'ready — POST to run one batch' });
}

export async function POST(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;
  const result = await runShadowSweep();
  return NextResponse.json({ ...META, ...result });
}
