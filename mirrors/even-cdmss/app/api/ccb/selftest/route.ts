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
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { individualsByUidsSql } from '@/lib/ccb-search-core';
import { metabaseQuery } from '@/lib/metabase';
import { flaggedListSql, boundedRace } from '@/lib/ccb-worklist-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Verbatim from app/api/ccb/worklist/route.ts — same gate, same order. */
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/** The worklist route's query, no date/pitch filter, capped at 100 (its default limit). */
const WORKLIST_PROBE_SQL =
  `SELECT presc_uid, uhid, individual_uid,
              to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date,
              coverage, priority, pitch_allowed, citation_coverage_pct, n_findings, doctor_speciality
       FROM ccb_briefs
       WHERE engine_version = $1
       ORDER BY pitch_allowed DESC NULLS LAST, citation_coverage_pct DESC NULLS LAST, created_at DESC
       LIMIT 100`;

const LEG_TIMEOUT_MS = 10_000;

type Leg = { ms: number } & ({ rows: number } | { resolved: number } | { error: string });

/**
 * Time one leg. The inner promise catches its own failure into `{error}` so a real error is
 * distinguishable from the race's `{error:'timeout'}` fallback. Never throws, never rejects.
 */
async function timeLeg<T extends object>(work: () => Promise<T>): Promise<{ ms: number; value: T | { error: string } }> {
  const t0 = Date.now();
  const guarded = work().catch((e: unknown) => ({ error: String((e as Error)?.message ?? e) }));
  const value = await boundedRace<T | { error: string }>(guarded, LEG_TIMEOUT_MS, { error: 'timeout' });
  return { ms: Date.now() - t0, value };
}

/**
 * CCB selftest — per-leg latency for the /care/briefs render path. DARK behind CCB_ENABLED.
 *   GET /api/ccb/selftest → { ok, deployment, legs: {neon_flagged, metabase_identity, neon_worklist}, total_ms }
 *
 * Runs the three legs SEQUENTIALLY, exactly as the page does, so the numbers are comparable to a
 * real render. Emits COUNTS AND MILLISECONDS ONLY — no names, uhids, uids, or any PHI. Every leg
 * degrades to `{error}` + a timing entry; the route never 500s on a query failure.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const t0 = Date.now();

  // (a) Neon — the flagged-list query the page runs.
  let uids: string[] = [];
  const flagged = await timeLeg(async () => {
    const rows = await run(flaggedListSql(), [CCB_ENGINE_VERSION]);
    // Held in memory for leg (b) only. Never emitted.
    uids = Array.from(new Set(rows.map((r) => String(r.individual_uid || '')).filter(Boolean)));
    return { rows: rows.length };
  });

  // (b) Metabase — the db13 identity batch for those uids.
  const identity = await timeLeg(async () => {
    if (!uids.length) return { resolved: 0 };
    const rows = await metabaseQuery(individualsByUidsSql(uids));
    return { resolved: rows.length };
  });

  // (c) Neon — the worklist API's query.
  const worklist = await timeLeg(async () => {
    const rows = await run(WORKLIST_PROBE_SQL, [CCB_ENGINE_VERSION]);
    return { rows: rows.length };
  });

  const legs = {
    neon_flagged: { ms: flagged.ms, ...flagged.value } as Leg,
    metabase_identity: { ms: identity.ms, ...identity.value } as Leg,
    neon_worklist: { ms: worklist.ms, ...worklist.value } as Leg,
  };
  const ok = ![flagged.value, identity.value, worklist.value].some((v) => 'error' in v);

  return NextResponse.json({
    ok,
    deployment: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    legs,
    total_ms: Date.now() - t0,
  });
}
