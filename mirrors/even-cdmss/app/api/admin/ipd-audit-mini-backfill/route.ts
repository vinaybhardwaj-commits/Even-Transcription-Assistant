export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fetchBacklogDocs, countDischargeCorpus } from '@/lib/ipd-audit/db13';
import { auditedDocIdsAnyVersion, auditedCountAnyVersion, IPD_MINI_ENGINE_VERSION } from '@/lib/ipd-audit/store';
import { runIpdAudit } from '@/lib/ipd-audit/run';
import { readState, miniAuditedCount, windowOpen, lockHeld, setSetting, IB_KEYS, IB_LOCK_TTL_MS } from '@/lib/ipd-audit/backfill';
import { MINI_MODEL } from '@/lib/llm';

/**
 * ⚠️ RETIRED FOR QWEN/MINI (V, 17-Jul-2026) — default-off, NO cron drives it. The Mini premise
 * failed measurement (303s/doc over the 300s cap; not ₹0 since the PDF extract is Gemini
 * regardless; and Qwen rubber-stamps at 0.1 low-value findings/doc vs Gemini's 2.8). The route
 * stays because the chain is model-agnostic — a future backfill flips one flag — but enabling it
 * on Qwen would fill the surface with rubber-stamp A rows. See lib/ipd-audit/backfill.ts.
 *
 * S6 — the IPD backfill autopilot (K=1, isolated engine version). Mirrors
 * /api/admin/opd-audit-mini-backfill: an autopilot tick (?auto=1, cron) gated by app_settings
 * switches + a soft lock, walking the discharge backlog OLDEST-FIRST.
 *
 * STAGE 1 (V): a hard `cap` (default 100) bounds the total docs this backfill may audit. The
 * tick refuses past it and pauses itself — releasing the full ~1,637 backlog is a SEPARATE go
 * after V spot-adjudicates the first batch on the live surface.
 *
 * Controls (admin/CRON authed):
 *   ?auto=1                       the cron tick
 *   ?enable=1|0 · ?window=night|always · ?n=1..4 · ?cap=N   set switches
 *   ?status=1                     read state + progress
 */

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  const denied = requireAdmin(req);
  if (!denied) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function progress() {
  const [corpus, audited, mini] = await Promise.all([
    countDischargeCorpus(), auditedCountAnyVersion(), miniAuditedCount(IPD_MINI_ENGINE_VERSION),
  ]);
  return { corpus, audited, mini_audited: mini, remaining: Math.max(0, corpus - audited) };
}

/** One autopilot tick. Never throws past the route; always releases the lock. */
async function tick() {
  const st = await readState();
  const base = { auto: true, enabled: st.enabled, window: st.window, n: st.n, cap: st.cap, engine: IPD_MINI_ENGINE_VERSION, model: MINI_MODEL };
  if (!st.enabled) return { ...base, skipped: 'paused' };
  if (!windowOpen(st.window)) return { ...base, skipped: 'outside the run window' };
  if (lockHeld(st.lock)) return { ...base, skipped: 'locked (a tick is still running)' };

  const doneSoFar = await miniAuditedCount(IPD_MINI_ENGINE_VERSION);
  if (doneSoFar >= st.cap) {
    // Stage-1 cap reached: pause ourselves so a cron can't drift past V's gate.
    await setSetting(IB_KEYS.enabled, '0');
    return { ...base, finished: true, mini_audited: doneSoFar, note: `Stage-1 cap ${st.cap} reached — autopilot paused itself; the full backlog is a separate go (V adjudicates this batch first)` };
  }

  await setSetting(IB_KEYS.lock, new Date().toISOString());
  const t0 = Date.now();
  try {
    const room = Math.max(1, Math.min(st.n, st.cap - doneSoFar));
    const already = await auditedDocIdsAnyVersion();
    const docs = await fetchBacklogDocs(already, room);
    if (!docs.length) {
      await setSetting(IB_KEYS.enabled, '0');
      return { ...base, finished: true, note: 'backlog empty — autopilot paused itself' };
    }
    // n is small (≤4) and the Mac-mini is a single box: serialise (conc 1), the OPD posture.
    const results = await mapLimit(docs, 1, (d) => runIpdAudit(d, { mini: true }));
    const okRuns = results.filter((r) => r.status);
    const avgMs = okRuns.length ? Math.round(okRuns.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / okRuns.length) : null;
    const last = {
      at: new Date().toISOString(), processed: results.length,
      inserted: okRuns.length, skipped: results.filter((r) => r.skip).length,
      errors: results.filter((r) => r.error).length, avg_ms: avgMs,
      tick_ms: Date.now() - t0,
    };
    await setSetting(IB_KEYS.last, JSON.stringify(last));
    return { ...base, ...last, mini_audited: doneSoFar + okRuns.length, progress: await progress(), results };
  } finally {
    await setSetting(IB_KEYS.lock, '').catch(() => { /* the TTL backstops a crashed tick */ });
  }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  try {
    // switches
    const en = p.get('enable'); const win = p.get('window'); const n = p.get('n'); const cap = p.get('cap');
    if (en != null) await setSetting(IB_KEYS.enabled, en === '1' ? '1' : '0');
    if (win === 'night' || win === 'always') await setSetting(IB_KEYS.window, win);
    if (n != null) await setSetting(IB_KEYS.n, String(Math.max(1, Math.min(4, Number(n) || 2))));
    if (cap != null) await setSetting(IB_KEYS.cap, String(Math.max(1, Math.floor(Number(cap) || 0))));
    if (en != null || win || n != null || cap != null) {
      return NextResponse.json({ ok: true, state: await readState(), progress: await progress() });
    }

    if (p.get('auto') === '1') return NextResponse.json({ ok: true, ...(await tick()) });

    return NextResponse.json({
      ok: true, state: await readState(), progress: await progress(),
      engine: IPD_MINI_ENGINE_VERSION, model: MINI_MODEL,
      lock_ttl_ms: IB_LOCK_TTL_MS,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
