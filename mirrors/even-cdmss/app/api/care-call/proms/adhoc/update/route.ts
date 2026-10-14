export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { generateAdhocSet, adhocSetIdForSeries } from '@/lib/proms/adhoc';
import { updateDraftItems, getAdhocSet, AdhocNotMigrated, AdhocFrozen } from '@/lib/proms/adhoc-store';
import { compileItemBank } from '@/lib/proms/item-bank-core';
import { validateAdhocSelection } from '@/lib/proms/adhoc-core';

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/**
 * POST — trim or regenerate a DRAFT adhoc set (T4). Draft-only: a frozen set is immutable ⇒ 409. DARK
 * behind TIER3_ENABLED. Two modes:
 *   trim:       { individual_uid, series_id?, item_ids:[...] }  → keep only these bank ids (validated), cap 6
 *   regenerate: { individual_uid, series_id?, procedure_context, regenerate:true } → fresh generation, replaces draft
 */
export async function POST(req: NextRequest) {
  if (process.env.TIER3_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const individual_uid = String(body.individual_uid ?? '').trim();
  if (!isUid(individual_uid)) return NextResponse.json({ error: 'individual_uid required' }, { status: 400 });
  const series_id = body.series_id ? String(body.series_id) : `psr:${individual_uid}`;
  const id = adhocSetIdForSeries(series_id);

  try {
    // Regenerate mode: re-run generation (upsert is a no-op if the set is already frozen).
    if (body.regenerate) {
      const existing = await getAdhocSet(id);
      if (existing && existing.status === 'frozen') return NextResponse.json({ error: 'frozen — immutable' }, { status: 409 });
      const procedure_context = String(body.procedure_context ?? '').trim();
      if (!procedure_context) return NextResponse.json({ error: 'procedure_context required to regenerate' }, { status: 400 });
      const now = new Date().toISOString().slice(0, 10);
      const set = await generateAdhocSet(series_id, individual_uid, procedure_context, now);
      return NextResponse.json({ ok: true, set });
    }

    // Trim mode: keep only the passed ids, run them through the same safety gate.
    const raw = Array.isArray(body.item_ids) ? (body.item_ids as unknown[]).map((x) => String(x)) : null;
    if (!raw) return NextResponse.json({ error: 'item_ids[] or regenerate required' }, { status: 400 });
    const validated = validateAdhocSelection(raw, compileItemBank());
    const updated = await updateDraftItems(id, validated.items.map((i) => i.id));
    return NextResponse.json({ ok: true, set: updated });
  } catch (e) {
    if (e instanceof AdhocFrozen) return NextResponse.json({ error: 'frozen — immutable' }, { status: 409 });
    if (e instanceof AdhocNotMigrated) return NextResponse.json({ error: 'not migrated — run /api/admin/migrate-adhoc-sets' }, { status: 503 });
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
