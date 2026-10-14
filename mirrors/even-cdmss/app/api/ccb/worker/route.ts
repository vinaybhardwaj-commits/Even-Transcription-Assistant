/**
 * ⚠️ RETIRED SURFACE — DO NOT DELETE. The mechanics here are LIVE.
 *
 * Care Conversation Briefs was retired as a care-manager product on 30 Jul 2026 — non-use, not
 * malfunction. The nav card is gone and the batch cron is paused, so this code is now invisible,
 * unused-looking and untraced: exactly the profile a tech-debt sweep deletes. It must not be.
 *
 * These mechanics are the best working example of ClinicalState, MemberState and the longitudinal
 * spine in the system, and they are RE-EXPOSED as a microservice behind /api/v1/patient-summary,
 * which feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). Deleting or
 * "cleaning up" anything here breaks that API.
 *
 * See: CDMSS-CCB-REPURPOSE-PRD-v0.1-30-JUL-2026 and the Patient Summary API kickoff (30 Jul 2026),
 * and the entry in CDMSS-OPEN-ISSUE-REGISTER-23-JUL-2026.md.
 *
 * ⚠️ HAZARD — CCB_ENABLED IS NOT A CCB FLAG. It gates ALL EIGHT /care pages: /care, /care/briefs,
 * /care/m/[uid], /care/[uid], /care/triage, /care/review, /care/lvc, /care/concepts. Setting it to
 * 0 does NOT disable CCB — it 404s the entire care-manager surface and takes down OPD Audit
 * Triage, LVC adjudication, Concept Coder and Review Mode with it. The flag keeps its name by
 * decision; this warning is the mitigation.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { assembleEpisode } from '@/lib/ccb-fetch';
import { generateBrief } from '@/lib/ccb-brief';
import { saveBrief, briefedUidsForSet, earliestBriefedDay } from '@/lib/ccb-store';
import { refreshMemberSnapshot } from '@/lib/ccb-dossier-cache';
import { countCcbNotesForDay, fetchCcbUidsForDay } from '@/lib/ccb-detect';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { istYesterday } from '@/lib/metabase';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { GEMINI_MODEL } from '@/lib/llm';

// Execution guard (spends Vertex compute): Vercel Cron (x-vercel-cron), Bearer/secret CRON_SECRET,
// OR a logged-in admin session (one-click run from a dashboard) — same contract as the OPD worker.
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
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

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

// Brief a batch of not-yet-briefed EHRC-cohort notes for one IST day. Dedup is uid-set based
// (immune to note_date tz edge-cases) — an already-briefed note is never re-generated/charged.
async function processDay(day: string, max: number, conc: number) {
  const candidates = await fetchCcbUidsForDay(day, 300);
  if (!candidates.length) return { day, total: 0, processed: 0, briefed: 0, remaining: 0, done: true, results: [] as unknown[] };
  const briefed = await briefedUidsForSet(candidates, CCB_ENGINE_VERSION);
  const todo = candidates.filter((u) => !briefed.has(u)).slice(0, max);

  // CCB v2 P1 warm-up: pre-build each briefed member's snapshot so the daytime open is a cache hit.
  // Started inside the loop (so it overlaps the next brief) but never awaited there — no brief is
  // blocked, slowed, or failed by it. Settled once, after the loop, so the promises actually run:
  // a floating promise would be dropped when the serverless function returns.
  const warmups: Promise<unknown>[] = [];

  const results = await mapLimit(todo, conc, async (uid) => {
    const started = Date.now();
    try {
      const bundle = await assembleEpisode(uid);
      if (!bundle) return { uid, status: 'no_episode' };
      const env = await generateBrief(bundle, { trace: false }); // batch: keep observability quiet
      const status = await saveBrief(env, bundle.keys, { model: GEMINI_MODEL, latencyMs: Date.now() - started });
      if (status === 'inserted' && bundle.keys.individualUid) {
        warmups.push(refreshMemberSnapshot(bundle.keys.individualUid).catch(() => null));
      }
      return { uid, coverage: env.episode.coverage, pitch: env.commercial.pitch_allowed, grounded: env.grounding_summary.citation_coverage_pct, status };
    } catch (e) {
      return { uid, error: String((e as Error).message) };
    }
  });

  // Each warm-up is already bounded to REFRESH_BUDGET_MS and can neither throw nor alter `results`.
  if (warmups.length) await Promise.allSettled(warmups);

  const inserted = results.filter((r) => 'status' in r && (r as { status?: string }).status === 'inserted').length;
  const briefedNow = briefed.size + inserted;
  const remaining = Math.max(0, candidates.length - briefedNow);
  return { day, total: candidates.length, processed: results.length, briefed: briefedNow, remaining, done: remaining === 0, results };
}

/**
 * CCB daily-batch worker (P2.2) — count-agnostic, resumable, GAP-PROOF, EHRC-cohort only.
 *  • ?day=YYYY-MM-DD → brief just that IST day (manual backfill).
 *  • default (cron)  → sweep a lookback window ending yesterday IST, OLDEST incomplete day first.
 * Idempotent (uid + engine_version), so caught-up days are cheap no-ops — no re-charge.
 * ?max (default 6, ≤20) · ?conc (default 3, ≤5) · ?lookback (default CCB_BATCH_LOOKBACK or 4, ≤14).
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const max = Math.max(1, Math.min(20, Number(p.get('max') || 6)));
  const conc = Math.max(1, Math.min(5, Number(p.get('conc') || 3)));
  const dayParam = p.get('day');

  try {
    if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      const r = await processDay(dayParam, max, conc);
      return NextResponse.json({ ok: true, mode: 'day', ...r });
    }

    const lookback = Math.max(1, Math.min(14, Number(p.get('lookback') || process.env.CCB_BATCH_LOOKBACK || 4)));
    const yesterday = istYesterday();
    const floor = (await earliestBriefedDay()) || yesterday;
    const days: string[] = [];
    for (let i = lookback - 1; i >= 0; i--) { const d = addDays(yesterday, -i); if (d >= floor) days.push(d); }
    const window = { from: days[0] ?? yesterday, to: yesterday };

    for (const d of days) {
      const total = await countCcbNotesForDay(d);
      if (total === 0) continue;
      const r = await processDay(d, max, conc);
      if (r.processed > 0 || !r.done) return NextResponse.json({ ok: true, mode: 'sweep', window, ...r });
    }
    return NextResponse.json({ ok: true, mode: 'sweep', window, caughtUp: true, done: true, processed: 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
