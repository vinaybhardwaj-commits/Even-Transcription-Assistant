export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { validateOutcome, type AskResponse } from '@/lib/care-call-core';
import { saveOutcome } from '@/lib/care-call-store';
import { servedVersionsForPresc } from '@/lib/inquiry/inquiry-store';
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

/** POST a completed call. Server validates (disposition/askIds/enums), derives + escalates + inserts.
 *  DARK behind CARE_CALL_ENABLED. Invalid → 400; table missing → 503; duplicate id → idempotent 200. */
export async function POST(req: NextRequest) {
  if (process.env.CARE_CALL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const id = String(body.id ?? '').trim();
  const presc_uid = String(body.presc_uid ?? '').trim();
  const individual_uid = String(body.individual_uid ?? '').trim();
  if (!id || !isUid(presc_uid) || !isUid(individual_uid)) return NextResponse.json({ error: 'id, presc_uid, individual_uid required' }, { status: 400 });

  const responses: AskResponse[] = Array.isArray(body.responses) ? (body.responses as AskResponse[]) : [];
  const served = new Set<string>((Array.isArray(body.served_ask_ids) ? (body.served_ask_ids as string[]) : []).map(String));
  const v = validateOutcome({ disposition: body.disposition, responses }, served);
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });

  // Inquiry K1 (additive): the client-echoed ask_set_version is passed through ONLY after
  // validating it against the persisted served sets for this episode (inquiry_asksets).
  // Unknown/absent/unvalidatable ⇒ default (ASK_SET_VERSION) — reads soft-fail to [].
  let askSetVersion: string | undefined;
  const echoed = typeof body.ask_set_version === 'string' ? body.ask_set_version.trim() : '';
  if (echoed) {
    const served = await servedVersionsForPresc(presc_uid).catch(() => [] as string[]);
    if (served.includes(echoed)) askSetVersion = echoed;
  }

  try {
    const res = await saveOutcome({
      id, presc_uid, individual_uid,
      uhid: body.uhid ? String(body.uhid) : null, note_date: body.note_date ? String(body.note_date) : null,
      disposition: body.disposition as never, responses, cm_ref: body.cm_ref ? String(body.cm_ref) : null,
      ask_set_version: askSetVersion,
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (/relation .*care_call_outcomes.* does not exist|not_migrated|does not exist/i.test(msg)) return NextResponse.json({ error: 'not migrated — run /api/admin/migrate-care-call' }, { status: 503 });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
