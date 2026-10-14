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
import { saveBrief, getBriefByUid } from '@/lib/ccb-store';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { resolveBriefUid } from '@/lib/ccb-resolve';
import { GEMINI_MODEL } from '@/lib/llm';

// Execution guard (spends LLM compute): a CCB_API_KEY (x-api-key / Bearer — the Pulse consumer
// path), Vercel Cron, Bearer/secret CRON_SECRET, a care-manager session, OR an admin session.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * Care Conversation Brief — on-demand (P1). DARK behind CCB_ENABLED (404 until set).
 *
 *   GET ?uid=<presc_uid>            → assemble the episode → grounded two-layer brief → persist → return.
 *       &fresh=1                    → bypass the read-through cache (regenerate).
 *       &dry=1                      → do not persist (debug).
 *
 * Returns the de-identified CcbEnvelope (PRD §12). P2 adds the SSE stage stream + ?individual_uid=&date=.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const fresh = p.get('fresh') === '1';
  const dry = p.get('dry') === '1';

  // Resolve a presc_uid: a direct ?uid=, or a Pulse member lookup ?member_id=/?uhid=/?individual_uid=
  // (optionally scoped to ?date=, else the member's latest episode).
  const { uid, candidates } = await resolveBriefUid({
    uid: (p.get('uid') || '').trim() || undefined,
    uhid: (p.get('uhid') || '').trim() || undefined,
    individualUid: (p.get('individual_uid') || '').trim() || undefined,
    memberId: (p.get('member_id') || '').trim() || undefined,
    date: (p.get('date') || '').trim() || undefined,
  });
  if (!uid) return NextResponse.json({ error: 'no episode found — pass ?uid=, or ?member_id=/?uhid=/?individual_uid= (optionally with ?date=)' }, { status: 404 });
  const resolved = { presc_uid: uid, episodes_that_day: candidates.length };

  try {
    if (!fresh) {
      const cached = await getBriefByUid(uid, CCB_ENGINE_VERSION).catch(() => null);
      if (cached) return NextResponse.json({ ...cached, resolved, cached: true });
    }

    const bundle = await assembleEpisode(uid);
    if (!bundle) return NextResponse.json({ error: 'prescription not found' }, { status: 404 });

    const started = Date.now();
    const envelope = await generateBrief(bundle);
    if (!dry) await saveBrief(envelope, bundle.keys, { model: GEMINI_MODEL, latencyMs: Date.now() - started }).catch(() => {});

    return NextResponse.json({ ...envelope, resolved });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
