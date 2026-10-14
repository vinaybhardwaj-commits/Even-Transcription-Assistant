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
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { getMemberSnapshot, refreshMemberSnapshot } from '@/lib/ccb-dossier-cache';
import { isSnapshotFresh, snapshotTtlHours } from '@/lib/ccb-dossier-cache-core';
import { bridgeMemberIdToIndividuals } from '@/lib/ccb-search';
import { bridgeUhidToIndividual } from '@/lib/ccb-resolve';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

// Same guard as the worklist/search: CCB_API_KEY (Pulse), care-manager session, admin, or CRON_SECRET.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * CCB member DOSSIER (whole-person record). DARK behind CCB_ENABLED.
 *   GET /api/ccb/dossier?individual_uid=<uid>   (or ?uhid= / ?member_id=)
 *     → { ok, dossier } — identity + snapshot + a unified care timeline (OPD + diagnostics +
 *       radiology + IPD/discharge). Deterministic; no LLM. Powers the /care member view.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  let individualUid = (p.get('individual_uid') || '').trim();
  const uhid = (p.get('uhid') || '').trim();
  const memberId = (p.get('member_id') || '').trim();

  try {
    if (!isUid(individualUid) && uhid) {
      individualUid = (await bridgeUhidToIndividual(uhid).catch(() => null)) || '';
    }
    if (!isUid(individualUid) && memberId) {
      const inds = await bridgeMemberIdToIndividuals(memberId).catch(() => [] as string[]);
      individualUid = inds[0] || '';
    }
    if (!isUid(individualUid)) return NextResponse.json({ error: 'pass ?individual_uid=, ?uhid=, or ?member_id=' }, { status: 400 });

    // ── cache-first (CCB v2 P1) ────────────────────────────────────────────────
    // The snapshot row is always read (one indexed PK lookup): `refresh=1` skips *serving* it,
    // but we still want it in hand as the stale fallback if the live re-assemble times out.
    const t0 = Date.now();
    const forceRefresh = p.get('refresh') === '1';
    const ttlH = snapshotTtlHours(process.env.CCB_SNAPSHOT_TTL_H);
    const cached = await getMemberSnapshot(individualUid);

    const done = (source: 'cache' | 'live' | 'stale', body: Record<string, unknown>, ageS: number | null) => {
      // counts/ms only — no PHI.
      console.log('[ccb-dossier-timing]', JSON.stringify({ source, snapshot_age_s: ageS, ms: Date.now() - t0 }));
      return NextResponse.json(body);
    };
    const ageOf = (ms: number) => Math.round((Date.now() - ms) / 1000);

    if (!forceRefresh && cached && isSnapshotFresh(cached.refreshedAt, ttlH, Date.now())) {
      const ageS = ageOf(cached.refreshedAt);
      return done('cache', { ok: true, dossier: cached.bundle, cached: true, snapshot_age_s: ageS }, ageS);
    }

    const fresh = await refreshMemberSnapshot(individualUid);
    if (fresh) return done('live', { ok: true, dossier: fresh, cached: false }, null);

    // db13 timed out or is unhealthy. A stale snapshot beats nothing.
    if (cached) {
      const ageS = ageOf(cached.refreshedAt);
      return done('stale', { ok: true, dossier: cached.bundle, cached: true, stale: true, snapshot_age_s: ageS }, ageS);
    }

    // No cache and no live bundle — the pre-existing behaviour, unchanged.
    return NextResponse.json({ error: 'member not found' }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
