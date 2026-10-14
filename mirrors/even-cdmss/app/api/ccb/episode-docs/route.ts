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
import { assembleEpisode } from '@/lib/ccb-fetch';
import { docsFromBundle } from '@/lib/ccb-episode-docs-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

// Verbatim from app/api/ccb/dossier/route.ts — same guard, same order.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * CCB episode SOURCE DOCUMENTS (P2 split-screen left pane). DARK behind CCB_ENABLED.
 *   GET /api/ccb/episode-docs?uid=<presc_uid>
 *     → { ok, docs:[{ kind, label, url, processedUrl }], encounter, member, coverage }
 *
 * Reuses `assembleEpisode()` verbatim — this route adds NO SQL. Read-only, no LLM, no persist.
 *
 * `docs` is the framable set (prescription first). `encounter` is the parsed note text, which the
 * pane renders when the episode is order-only and there is no prescription PDF to frame.
 * `member` carries the back-link + chip identifiers — join-back data for the care manager, never
 * sent to any model (the brief on the right is de-identified exactly as before).
 *
 * Soft-fails to `{ ok:false, docs:[] }` at HTTP 200: this pane must never 500 the brief screen.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const uid = (req.nextUrl.searchParams.get('uid') || '').trim();
  if (!isUid(uid)) {
    return NextResponse.json({ ok: false, error: 'pass ?uid=<presc_uid>', docs: [] }, { status: 400 });
  }

  try {
    const bundle = await assembleEpisode(uid);
    if (!bundle) return NextResponse.json({ ok: false, error: 'episode not found', docs: [] });

    const rx = bundle.prescription;
    return NextResponse.json({
      ok: true,
      docs: docsFromBundle(bundle),
      coverage: bundle.coverage,
      member: {
        individualUid: bundle.keys.individualUid ?? null,
        uhid: bundle.keys.kxUhid ?? null,
        noteDate: bundle.keys.noteDate ?? null,
      },
      encounter: {
        presentingComplaint: rx?.presentingComplaint ?? null,
        diagnoses: rx?.diagnoses ?? [],
        investigations: rx?.investigations ?? [],
        planOfManagement: rx?.planOfManagement ?? null,
      },
    });
  } catch (e) {
    // Never 500 the pane — the brief on the right must still render.
    return NextResponse.json({ ok: false, error: String((e as Error).message), docs: [] });
  }
}
