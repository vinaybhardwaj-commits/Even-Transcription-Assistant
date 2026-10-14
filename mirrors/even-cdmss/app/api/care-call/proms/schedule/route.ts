export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { fetchSurgicalSeries } from '@/lib/proms/schedule';
import { ensureSeries, responsesForMember } from '@/lib/proms/store';

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * PROMs 0.2a-2 — the surgical-recovery schedule for a member. DARK behind PROMS_ENABLED (unset ⇒ 404).
 * Read-only: detects the series from db13 (fail-safe) + returns the compiled due list and any stored
 * administrations so the panel can mark windows done. No series → { ok:true, series:null } (panel hides).
 *   GET /api/care-call/proms/schedule?individual_uid=<uid>
 */
export async function GET(req: NextRequest) {
  if (process.env.PROMS_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const individualUid = (req.nextUrl.searchParams.get('individual_uid') || '').trim();
  if (!isUid(individualUid)) return NextResponse.json({ error: 'pass ?individual_uid=' }, { status: 400 });

  try {
    const now = new Date().toISOString().slice(0, 10);   // the ROUTE stamps now; the pure compiler never calls Date.now
    const series = await fetchSurgicalSeries(individualUid, now).catch(() => null);
    if (!series) return NextResponse.json({ ok: true, series: null });

    // best-effort persistence of the detected series (never fail the read on a missing table)
    await ensureSeries({
      individual_uid: individualUid, family: series.family, archetype: series.archetype,
      procedure_name: series.procedureName, planned_date: series.plannedDate,
      discharge_date: series.dischargeDate, status: series.status,
    }).catch(() => { /* not migrated / read-only — panel still renders */ });

    const administered = await responsesForMember(individualUid, 200);
    return NextResponse.json({ ok: true, series, administered });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
