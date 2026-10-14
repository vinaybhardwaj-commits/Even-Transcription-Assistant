export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * 800 s, matching the IPD episode worker. The tick's own loop stops at 4 items or 500 s
 * elapsed (§5.3.6), so the box is comfortably larger than the work it authorises — the
 * reserve absorbs one long final item rather than being consumed by routine load.
 * The paired slice then uses whatever of that budget is left, several items at a time.
 */
/** Kept in step with maxDuration. The paired slice is whatever this budget has left. */
const ROUTE_BUDGET_MS = 800_000;
export const maxDuration = 800;

/**
 * /api/admin/lab-v2/tick — the Lab v2 queue tick (LAB-MCP-V2-PRD-v1.0 §5.3, decision 3).
 *
 * ⚠️ THE FLAG GUARDS `?auto=1`, NOT THE ROUTE — the shape is inherited verbatim from
 * app/api/ipd-episode/worker/route.ts (decision 53), and for the same reasons:
 *
 *   · A manual tick without `auto` runs regardless of LAB_V2_ENABLED. That caller is an
 *     orchestrator ticking a named run ON PURPOSE; an unattended cron sweep is not.
 *   · The disabled auto path returns 200, not 403, and returns BEFORE any database read.
 *     A cron firing into a disabled engine must be free, must not look like a failure in
 *     the log, and must not block a manual run.
 *
 * The auth guard is likewise inherited: Vercel Cron header, Bearer/query CRON_SECRET, or
 * a logged-in admin session. What is NOT inherited is the lock: the IPD worker holds a
 * single TTL lock in app_settings, while v2 uses per-item row leases (§5.3), so two ticks
 * overlapping is normal and safe rather than something to serialise.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { labV2Configured, postgres } from '@/lib/lab-v2/db';
import { liveTransport } from '@/lib/lab-v2/transport';
import { tick } from '@/lib/lab-v2/worker';
import { defaultPairedDeps, pairedAuditTick } from '@/lib/lab-v2/paired-audit';
import { pairedAuditConcurrency } from '@/lib/lab-v2/paired-audit-core';

/** Byte-identical in shape to the IPD episode worker's guard. */
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const auto = req.nextUrl.searchParams.get('auto') === '1';
  // Before any database read, and 200 rather than 403 — see the header note.
  if (auto && process.env.LAB_V2_ENABLED !== '1') {
    return NextResponse.json({ ok: true, skipped: 'disabled' });
  }
  if (!labV2Configured()) return NextResponse.json({ ok: true, skipped: 'unconfigured' });

  try {
    const routeStarted = Date.now();
    const db = await postgres();
    const report = await tick({ db, transport: liveTransport });
    // Paired audits share this cron. A missing 0003 migration, or any other failure here,
    // must not turn the existing tick into a 500. The log line is a name and a path.
    // The deadline is the route's remaining time, not a clock that starts when this
    // slice starts. 20s stays in reserve so the response can still be written.
    let paired: unknown = { skipped: 'not_run' };
    try {
      const remaining = ROUTE_BUDGET_MS - (Date.now() - routeStarted) - 20_000;
      if (remaining < 5_000) {
        paired = { skipped: 'no_time' };
      } else {
        // The slice keeps the route's remaining time. Concurrency is capped inside
        // the claim, so a cron that overlaps this invocation cannot stack past it.
        paired = await pairedAuditTick(db, defaultPairedDeps(), {
          concurrency: pairedAuditConcurrency(),
          deadlineAt: Date.now() + remaining,
        });
      }
    } catch (err) {
      console.error('[lab-v2/tick] paired audit skipped:', (err as Error).name ?? 'Error');
      paired = { skipped: 'paired_audit_unavailable' };
    }
    return NextResponse.json({ ok: true, mode: auto ? 'auto' : 'manual', ...report, paired });
  } catch (e) {
    // §13 — a dead store is a skipped tick and a log line, NEVER a 500. A cron that
    // 500s wakes people up; a cron that reports `store_unavailable` is diagnosable.
    console.error('[lab-v2/tick] store unavailable:', (e as Error).message);
    return NextResponse.json({ ok: true, skipped: 'store_unavailable', error: (e as Error).message });
  }
}
