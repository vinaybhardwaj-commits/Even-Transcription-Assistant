export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { outcomesForMember, outcomesForPresc } from '@/lib/care-call-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/** Saved outcomes for the dossier/panel. DARK behind CARE_CALL_ENABLED. Soft — empty on any error. */
export async function GET(req: NextRequest) {
  if (process.env.CARE_CALL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const individualUid = (req.nextUrl.searchParams.get('individual_uid') || '').trim();
  const prescUid = (req.nextUrl.searchParams.get('presc_uid') || '').trim();
  const outcomes = isUid(individualUid) ? await outcomesForMember(individualUid)
    : isUid(prescUid) ? await outcomesForPresc(prescUid)
      : null;
  if (outcomes === null) return NextResponse.json({ error: 'pass ?individual_uid= or ?presc_uid=' }, { status: 400 });
  return NextResponse.json({ ok: true, outcomes });
}
