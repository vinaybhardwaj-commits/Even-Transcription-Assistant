export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * READMISSION-NARRATIVE BACKFILL RUNNER (CDMSS-READMISSIONS-R4-PRD v1.0 R4-8 / R4-11, 18 Aug 2026)
 * — the readmission worker on the Bedrock backfill rails (lib/backfill-runs*.ts, production-
 * verified 8 Aug). One run = Opus 4.6 on Bedrock over a range of audited_at (UTC) days, writing
 * the case narrative / evidence ledger / related-LVC artefacts onto audited findings that lack
 * them. All decisions in lib/readmission/narrative-backfill.ts (+ the rails' pure core).
 *
 * NEVER AUTO-STARTED: a run exists only when an operator POSTs start_run. The tick is driven by
 * the existing every-2-minutes OPD backfill cron when the OPD worker is idle (see
 * /api/admin/opd-audit-mini-backfill) and by ?auto=1 here. The Vertex readmission worker box is
 * untouched. Carried S2 rules: n ≤ 2 (clamped), progress surface = the GET status payload
 * (pace / ETA / stall / backlog), stop → wait one tick → confirm.
 *
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session — the OPD runner's.
 *   GET  ?auto=1                       → work the active run (one tick)
 *   GET                                → status (the progress surface)
 *   POST {action:'start_run', model:'bedrock:global.anthropic.claude-opus-4-6-v1', dayFrom, dayTo, nPerTick}
 *   POST {action:'pause'|'resume'|'stop'|'status'}
 *   POST {action:'run_one', dedup_key, force?}   → ONE finding, off-ledger (its trace carries the cost)
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { logTick } from '@/lib/mini-backfill';
import { narrativeTick, narrativeStatus, startNarrativeRun, controlNarrativeRun, narrateOneByKey } from '@/lib/readmission/narrative-backfill';

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
  if (req.nextUrl.searchParams.get('auto') === '1') {
    try { return NextResponse.json({ ok: true, ...(await narrativeTick()) }); }
    catch (e) {
      await logTick({ status: 'error', note: String((e as Error).message).slice(0, 200) }).catch(() => {});
      return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
    }
  }
  try { return NextResponse.json({ ok: true, ...(await narrativeStatus()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty ⇒ status */ }
  const action = String(body.action ?? 'status').trim().toLowerCase();
  try {
    if (action === 'status') return NextResponse.json({ ok: true, ...(await narrativeStatus()) });
    if (action === 'start_run') {
      const r = await startNarrativeRun(body);
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, run: r.run });
    }
    if (action === 'pause' || action === 'resume' || action === 'stop') {
      const r = await controlNarrativeRun(action);
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, run_id: r.run_id, status: r.status });
    }
    if (action === 'run_one') {
      const key = String(body.dedup_key ?? '').trim();
      if (!key || key.length > 200 || !/^[A-Za-z0-9/_:|.-]+$/.test(key)) return NextResponse.json({ ok: false, error: 'dedup_key required' }, { status: 400 });
      const r = await narrateOneByKey(key, body.force === true);
      return NextResponse.json({ ...r, ok: r.ok });
    }
    return NextResponse.json({ ok: false, error: `unknown action '${action}' — expected start_run | pause | resume | stop | status | run_one` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
