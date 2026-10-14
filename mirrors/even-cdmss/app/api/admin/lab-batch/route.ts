export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * COHORT-SCOPED LAB EVAL BATCH (5 Jul 2026) — drains a uid cohort through the FREE mini
 * (qwen, ₹0) into lab_analyses (experiment-namespaced). NEVER writes opd_note_audits.
 *   · POST         → create/replace a job { experiment, uids[] | cohort_sql, n?, window?, kind? }
 *   · GET          → status + progress
 *   · GET ?auto=1  → the cron tick (drain up to n; yields to the prod mini-backfill)
 * Auth: Vercel cron header / CRON_SECRET for the tick; ADMIN_TOKEN / admin session for POST+status.
 */
import { NextRequest, NextResponse } from 'next/server';
import { telemetryContextFor } from '@/lib/retrieval-telemetry-core';
import { startInvocation } from '@/lib/retrieval-invocation-store';
import { sql } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { guardReadOnlySql } from '@/lib/sql-guard-core';
import { ensureLabTables } from '@/lib/lab';
import { setSetting } from '@/lib/mini-backfill';
import { LB_KEYS, sanitizeUids, clampN } from '@/lib/lab-batch-core';
import { readBatchState, batchProgress, batchTick } from '@/lib/lab-batch';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  const tokenOk = requireAdmin(req) === null; // ADMIN_TOKEN (or dev-mode when unset)
  if (isCron || bearerOk || secretOk || tokenOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (req.nextUrl.searchParams.get('auto') === '1') {
    try {
      // The boundary makes the context; batchTick only carries it (D11).
      const ctx = telemetryContextFor('lab_batch', req.headers);
      await startInvocation(ctx);
      return NextResponse.json({ ok: true, ...(await batchTick({ telemetry: ctx })) });
    }
    catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
  }
  const st = await readBatchState();
  const prog = st.experiment ? await batchProgress(st.experiment, st.uids) : { total: 0, done: 0, remaining: 0 };
  return NextResponse.json({
    ok: true, enabled: st.enabled, experiment: st.experiment, kind: st.kind,
    n: st.n, window: st.window, ...prog, last_error: st.lastError, last: st.last,
  });
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = await req.json() as Record<string, unknown>; } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }

  // Lightweight pause/resume for the console — toggles the active job without re-seeding the cohort.
  const action = String(body.action ?? '');
  if (action === 'pause' || action === 'resume') {
    await setSetting(LB_KEYS.enabled, action === 'resume' ? '1' : '0');
    const cur = await readBatchState();
    const p = cur.experiment ? await batchProgress(cur.experiment, cur.uids) : { total: 0, done: 0, remaining: 0 };
    return NextResponse.json({ ok: true, action, enabled: cur.enabled, experiment: cur.experiment, ...p });
  }

  // Stop-and-clear — retire a cancelled batch: wipe the cohort + progress so it stops lingering in
  // app_settings (and can't be Resumed). Does NOT touch opd_note_audits / lab_analyses history.
  if (action === 'stop') {
    await setSetting(LB_KEYS.experiment, '');
    await setSetting(LB_KEYS.uids, '[]');
    await setSetting(LB_KEYS.enabled, '0');
    await setSetting(LB_KEYS.error, '');
    await setSetting(LB_KEYS.lock, '');
    return NextResponse.json({ ok: true, action: 'stop', cleared: true });
  }

  const experiment = String(body.experiment ?? '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
  if (!experiment) return NextResponse.json({ error: 'experiment required (a-z0-9_-, <=64)' }, { status: 400 });

  let uids = sanitizeUids(body.uids);
  const cohortSql = String(body.cohort_sql ?? '').trim();
  if (uids.length === 0 && cohortSql) {
    const g = guardReadOnlySql(cohortSql, 2000);
    if (!g.ok) return NextResponse.json({ error: `cohort_sql: ${g.error}` }, { status: 400 });
    let rows: Record<string, unknown>[];
    try { rows = await run(g.sql, []); } catch (e) { return NextResponse.json({ error: `cohort_sql failed: ${String((e as Error).message)}` }, { status: 400 }); }
    uids = sanitizeUids(rows.map((r) => (r.uid ?? Object.values(r)[0])));
  }
  if (uids.length === 0) return NextResponse.json({ error: 'no uids — pass uids[] or a cohort_sql returning a uid column' }, { status: 400 });

  const n = clampN(body.n ?? 2);
  const window = String(body.window ?? '') === 'always' ? 'always' : 'night';
  const kind = String(body.kind ?? 'opd').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'opd';

  await ensureLabTables();
  await setSetting(LB_KEYS.experiment, experiment);
  await setSetting(LB_KEYS.uids, JSON.stringify(uids));
  await setSetting(LB_KEYS.n, String(n));
  await setSetting(LB_KEYS.window, window);
  await setSetting(LB_KEYS.kind, kind);
  await setSetting(LB_KEYS.error, '');
  await setSetting(LB_KEYS.enabled, '1');

  const prog = await batchProgress(experiment, uids);
  return NextResponse.json({
    ok: true, experiment, kind, n, window, ...prog,
    note: 'queued — the */2 cron drains it (mini, ₹0), yielding to the prod backfill. Poll GET or MCP lab_batch_status.',
  });
}
