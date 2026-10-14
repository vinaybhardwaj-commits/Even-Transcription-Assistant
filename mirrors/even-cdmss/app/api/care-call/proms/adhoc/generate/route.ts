export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { generateAdhocSet } from '@/lib/proms/adhoc';
import { AdhocNotMigrated } from '@/lib/proms/adhoc-store';

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * POST — CM-initiated Tier-3 adhoc generation for an UNMAPPED surgical series. The model SELECTS ≤6
 * existing house-item ids from the bank (never authors text); the result persists as a draft. DARK
 * behind TIER3_ENABLED (unset ⇒ 404). Soft-fail (LLM off/empty) ⇒ { ok:true, set:null } (panel falls
 * back to core+PREM). Table missing ⇒ 503.
 *   body: { individual_uid, series_id?, procedure_context }
 */
export async function POST(req: NextRequest) {
  if (process.env.TIER3_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const individual_uid = String(body.individual_uid ?? '').trim();
  const procedure_context = String(body.procedure_context ?? '').trim();
  if (!isUid(individual_uid)) return NextResponse.json({ error: 'individual_uid required' }, { status: 400 });
  if (!procedure_context) return NextResponse.json({ error: 'procedure_context required' }, { status: 400 });
  const series_id = body.series_id ? String(body.series_id) : `psr:${individual_uid}`;

  try {
    const now = new Date().toISOString().slice(0, 10);   // route stamps now; pure engine never calls Date.now
    const set = await generateAdhocSet(series_id, individual_uid, procedure_context, now);
    return NextResponse.json({ ok: true, set });          // set === null ⇒ panel uses core+PREM
  } catch (e) {
    if (e instanceof AdhocNotMigrated) return NextResponse.json({ error: 'not migrated — run /api/admin/migrate-adhoc-sets' }, { status: 503 });
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
