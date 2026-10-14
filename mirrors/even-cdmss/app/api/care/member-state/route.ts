export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { bridgeMemberIdToIndividuals } from '@/lib/ccb-search';
import { bridgeUhidToIndividual } from '@/lib/ccb-resolve';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { getMemberSnapshot, individualUidForPresc } from '@/lib/member-state/member-state';
import { presentMemberState } from '@/lib/member-state/present-core';

// Same guard as the CCB dossier / workspace route (verbatim): CCB_API_KEY (Pulse), care-manager
// session, admin, or CRON_SECRET.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * MemberState Stage 2 (Phase 1) — the CM's validated read context. DARK behind CCB_ENABLED AND the
 * new MEMBER_STATE_UI flag (either unset ⇒ 404). Renders the SAME snapshot the Stage-1 freeze
 * validated; read-only, writes nothing.
 *   GET /api/care/member-state?individual_uid=<uid> | ?uhid= | ?member_id= | ?presc_uid=<episode>
 *     → { ok, snapshot, view }   (404 when there is no member / no evidence)
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1' || process.env.MEMBER_STATE_UI !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  let individualUid = (p.get('individual_uid') || '').trim();
  const uhid = (p.get('uhid') || '').trim();
  const memberId = (p.get('member_id') || '').trim();
  const prescUid = (p.get('presc_uid') || '').trim();

  try {
    if (!isUid(individualUid) && uhid) individualUid = (await bridgeUhidToIndividual(uhid).catch(() => null)) || '';
    if (!isUid(individualUid) && memberId) {
      const inds = await bridgeMemberIdToIndividuals(memberId).catch(() => [] as string[]);
      individualUid = inds[0] || '';
    }
    if (!isUid(individualUid) && prescUid) individualUid = (await individualUidForPresc(prescUid)) || '';
    if (!isUid(individualUid)) return NextResponse.json({ error: 'pass ?individual_uid=, ?uhid=, ?member_id=, or ?presc_uid=' }, { status: 400 });

    const computedAt = new Date().toISOString();   // the ROUTE stamps computedAt; the frozen core never calls Date.now()
    const snapshot = await getMemberSnapshot(individualUid, computedAt);
    if (!snapshot) return NextResponse.json({ error: 'member not found' }, { status: 404 });
    // individualUid is echoed so the call card can link "Full clinical state ↗" → /care/m/[uid].
    return NextResponse.json({ ok: true, individualUid, snapshot, view: presentMemberState(snapshot) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
