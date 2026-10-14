export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * READMISSION TEMPLATE-REFRESH RUNNER (CDMSS-READMISSIONS-R4.1-PRD v1.0 R41-4..R41-7, 18 Aug 2026)
 * — the readmission_refresh worker on the Bedrock backfill rails. Re-analyzes audited findings
 * whose stays NOW carry final OT / PAC / progress rows the stored coverage does not reflect: full
 * re-assemble → the same recon legs on Opus 4.6 (Bedrock) → judgements re-derived by the untouched
 * rules → narrative rewritten → saved IN PLACE at (dedup_key, engine 0.2). One case per tick.
 * All decisions in lib/readmission/refresh.ts + lib/readmission-refresh-core.ts.
 *
 * THE PROBE GATE (R41-5, S2 discipline): start_run is REFUSED (412) until action:probe on a named
 * OT-bearing case has shown every recon leg closing valid JSON on Opus for the CURRENT prompt
 * fingerprints. Prompts change → probe again. NEVER auto-started.
 *
 * Auth: Vercel cron header / Bearer|?secret=CRON_SECRET / admin session — the OPD runner's.
 *   GET  ?auto=1                                    → work the active run (one tick)
 *   GET                                             → status: refresh_pending count, probe gate, run, pace / ETA / stall
 *   POST {action:'probe', dedup_key, save?}          → ONE case on Opus, per-leg JSON closure + verdicts; writes NOTHING unless save:true
 *   POST {action:'start_run', model:'bedrock:global.anthropic.claude-opus-4-6-v1', dayFrom, dayTo}   (n_per_tick forced to 1)
 *   POST {action:'pause'|'resume'|'stop'|'status'}
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { logTick } from '@/lib/mini-backfill';
import { refreshTick, refreshStatus, startRefreshRun, controlRefreshRun, probeCase } from '@/lib/readmission/refresh';

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

const isDedupKey = (s: string) => s.length >= 3 && s.length <= 200 && /^[A-Za-z0-9/_:|.-]+$/.test(s);

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (req.nextUrl.searchParams.get('auto') === '1') {
    try { return NextResponse.json({ ok: true, ...(await refreshTick()) }); }
    catch (e) {
      await logTick({ status: 'error', note: String((e as Error).message).slice(0, 200) }).catch(() => {});
      return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
    }
  }
  try { return NextResponse.json({ ok: true, ...(await refreshStatus()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty ⇒ status */ }
  const action = String(body.action ?? 'status').trim().toLowerCase();
  try {
    if (action === 'status') return NextResponse.json({ ok: true, ...(await refreshStatus()) });
    if (action === 'probe') {
      const key = String(body.dedup_key ?? '').trim();
      if (!key || !isDedupKey(key)) return NextResponse.json({ ok: false, error: 'dedup_key required' }, { status: 400 });
      const r = await probeCase(key, body.save === true);
      return NextResponse.json({ ...r, ok: r.ok });
    }
    if (action === 'start_run') {
      const r = await startRefreshRun(body);
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, run: r.run, probe: r.probe });
    }
    if (action === 'pause' || action === 'resume' || action === 'stop') {
      const r = await controlRefreshRun(action);
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
      return NextResponse.json({ ok: true, run_id: r.run_id, status: r.status });
    }
    return NextResponse.json({ ok: false, error: `unknown action '${action}' — expected probe | start_run | pause | resume | stop | status` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
