export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { savePromResponse } from '@/lib/proms/store';
import { instrumentById } from '@/lib/proms/catalog';
import type { ItemResponse } from '@/lib/proms/schedule-core';

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * POST one PROM administration. Server SCORES it (scoreInstrument) — the client's score is never
 * trusted — and stores the immutable raw. DARK behind PROMS_ENABLED. Invalid → 400; table missing → 503.
 *   body: { id, individual_uid, instrument_id, window, raw:[{itemId,value}], series_id?, administered_at?, cm_ref?, adhoc_set_ref? }
 */
export async function POST(req: NextRequest) {
  if (process.env.PROMS_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const id = String(body.id ?? '').trim();
  const individual_uid = String(body.individual_uid ?? '').trim();
  const instrument_id = String(body.instrument_id ?? '').trim();
  const window = String(body.window ?? '').trim();
  if (!id || !isUid(individual_uid) || !instrument_id || !window) {
    return NextResponse.json({ error: 'id, individual_uid, instrument_id, window required' }, { status: 400 });
  }
  // Tier-3 (0.2b-2): an adhoc administration's instrument_id is the adhoc set ref (not a catalog id);
  // it's scored via scoreAdhocSet in the store. Only require a known catalog id for non-adhoc rows.
  const adhocRef = body.adhoc_set_ref ? String(body.adhoc_set_ref).trim() : '';
  if (!adhocRef && !instrumentById(instrument_id)) return NextResponse.json({ error: 'unknown instrument_id' }, { status: 400 });
  const raw: ItemResponse[] = Array.isArray(body.raw)
    ? (body.raw as unknown[]).filter((r): r is ItemResponse => !!r && typeof (r as ItemResponse).itemId === 'string' && typeof (r as ItemResponse).value === 'string')
    : [];
  if (!raw.length) return NextResponse.json({ error: 'raw[] (itemId,value) required' }, { status: 400 });

  try {
    const res = await savePromResponse({
      id, series_id: body.series_id ? String(body.series_id) : null, individual_uid, instrument_id, window,
      administered_at: body.administered_at ? String(body.administered_at) : undefined,
      raw, adhoc_set_ref: body.adhoc_set_ref ? String(body.adhoc_set_ref) : null,
      cm_ref: body.cm_ref ? String(body.cm_ref) : null,
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (/relation .*prom_responses.* does not exist|does not exist|not_migrated/i.test(msg)) {
      return NextResponse.json({ error: 'not migrated — run /api/admin/migrate-proms' }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
