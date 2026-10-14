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
import { searchMembers } from '@/lib/ccb-search';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

// Same guard as the worklist: CCB_API_KEY (Pulse), care-manager session, admin session, or CRON_SECRET.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * CCB member SEARCH (Pulse parity). DARK behind CCB_ENABLED.
 *   GET /api/ccb/search?q=<member id | phone | name | uid | uhid>[&limit=12]
 *     → { ok, count, members: MemberHit[] } ranked (has-episodes first, then most-recent visit).
 *   Powers the /care surface's member picker. Auth: care/admin session or x-api-key CCB_API_KEY.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const q = (p.get('q') || '').trim();
  const limit = Math.max(1, Math.min(25, Number(p.get('limit') || 12)));
  if (q.length < 2) return NextResponse.json({ ok: true, count: 0, members: [] });

  try {
    const members = await searchMembers(q, { limit });
    return NextResponse.json({ ok: true, count: members.length, members });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
