/**
 * GET/POST /api/admin/wm3-join — run one bounded WM3 join.
 *
 * GET  ?auto=1  = the unattended cron tick, every 6h via vercel.json, one hour after the shadow
 *                 sweep so the events it opens over are already written. Cron-auth mirrors
 *                 /api/admin/shadow-sweep EXACTLY: the Vercel cron header, a CRON_SECRET
 *                 Bearer/?secret, or an admin session. All four phases (0 → 1 → 2 → 3).
 * GET           = status only. Reports the versions and caps without writing.
 * POST          = a manual run. Auth: ADMIN_TOKEN (Bearer / ?token=) or an admin session.
 *                 `{ mode:'backfill', limit:50 }` runs phase 1 only — the first runs of the join
 *                 are backfills, and everything they open is `reconstructed` by construction.
 *                 Add `include_stale_era:true` to run phase 1 a second time over the events the
 *                 burden policy refused as `stale_era` (era_status 'stale').
 *                 `{ mode:'raw_notes', limit }` runs phase 0 only — raw db13 headache notes under
 *                 `headache-raw/1`, era_status 'unaudited'.
 *                 `{ mode:'stability' }` re-reconstructs a deterministic sample of O_before and
 *                 records the match rate. Reads only; writes nothing to cognition_snapshots.
 *                 `{ mode:'retry_failed' }` (or `?retry_failed=1`) re-captures the O_after
 *                 snapshots that were an outage.
 *
 * ⚠️ THE CRON NEVER OPENS THE STALE-ERA BACKLOG. `include_stale_era` is reachable only from a POST
 * body, so re-opening notes the policy refused stays a decision somebody made and can point at.
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
  runJoinSweep, runJoinBackfill, runJoinRetryFailed, runJoinRawNotes, runJoinStability,
  JOIN_TRIGGER_KIND, JOIN_MICROWORLD, JOIN_Y_KIND, Y_HORIZON_DAYS,
  PHASE1_CAP, PHASE2_CAP, PHASE3_CAP, BACKFILL_CAP, PACING_MS, SWEEP_BUDGET_MS,
  RAW_TRIGGER_KIND, RAW_PHASE_CAP, RAW_MANUAL_CAP, RAW_MATCH_RULE, RAW_NOTE_FLOOR,
  STABILITY_SAMPLE_N,
} from '@/lib/cognition/join-sweep';
import { BURDEN_POLICY_VERSION, JOIN_SCHEMA_VERSION } from '@/lib/cognition/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const META = {
  phiWarning: 'Writes PHI (cognition_snapshots, cognition_triples, cognition_join_stability). Not readable by the Lab scope.',
  triggerKind: JOIN_TRIGGER_KIND,
  microworld: JOIN_MICROWORLD,
  yKind: JOIN_Y_KIND,
  horizonDays: Y_HORIZON_DAYS,
  caps: {
    phase0: RAW_PHASE_CAP, phase1: PHASE1_CAP, phase2: PHASE2_CAP, phase3: PHASE3_CAP,
    backfill: BACKFILL_CAP, rawManual: RAW_MANUAL_CAP, stabilitySample: STABILITY_SAMPLE_N,
    pacingMs: PACING_MS, budgetMs: SWEEP_BUDGET_MS,
  },
  rawTriggerKind: RAW_TRIGGER_KIND,
  rawRule: RAW_MATCH_RULE,
  rawNoteFloor: RAW_NOTE_FLOOR,
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
    // The stale-era pass is opt-in and never defaulted on: it opens notes the burden policy
    // deliberately refused, which is a decision somebody makes, not a schedule.
    const includeStale = body.include_stale_era === true;
    return NextResponse.json({ ...META, ...(await runJoinBackfill(limit, {}, { include_stale_era: includeStale })) });
  }
  if (mode === 'raw_notes') {
    const limit = Number.isInteger(body.limit) ? (body.limit as number) : RAW_PHASE_CAP;
    return NextResponse.json({ ...META, ...(await runJoinRawNotes(limit)) });
  }
  if (mode === 'stability') {
    return NextResponse.json({ ...META, ...(await runJoinStability()) });
  }
  if (mode === 'retry_failed' || retryFlag) {
    return NextResponse.json({ ...META, ...(await runJoinRetryFailed()) });
  }
  return NextResponse.json({ ...META, ...(await runJoinSweep()) });
}
