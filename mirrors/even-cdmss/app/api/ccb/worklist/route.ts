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

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * CCB worklist API (Pulse). DARK behind CCB_ENABLED.
 *   GET /api/ccb/worklist[?date=YYYY-MM-DD][&pitch=1][&limit=100]
 *     → briefs ranked pitch_allowed → citation_coverage → recency. `pitch=1` returns only flagged
 *       candidates; `date` filters to one IST note day. Auth: x-api-key/Bearer CCB_API_KEY (Pulse).
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const date = (p.get('date') || '').trim();
  const pitchOnly = p.get('pitch') === '1';
  const limit = Math.max(1, Math.min(500, Number(p.get('limit') || 100)));

  const where = ['engine_version = $1'];
  const params: unknown[] = [CCB_ENGINE_VERSION];
  if (pitchOnly) where.push('pitch_allowed = true');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { params.push(date); where.push(`(note_date AT TIME ZONE 'Asia/Kolkata')::date = $${params.length}::date`); }

  try {
    const rows = await run(
      `SELECT presc_uid, uhid, individual_uid,
              to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date,
              coverage, priority, pitch_allowed, citation_coverage_pct, n_findings, doctor_speciality
       FROM ccb_briefs
       WHERE ${where.join(' AND ')}
       ORDER BY pitch_allowed DESC NULLS LAST, citation_coverage_pct DESC NULLS LAST, created_at DESC
       LIMIT ${limit}`,
      params,
    );
    return NextResponse.json({ ok: true, engine_version: CCB_ENGINE_VERSION, count: rows.length, items: rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
