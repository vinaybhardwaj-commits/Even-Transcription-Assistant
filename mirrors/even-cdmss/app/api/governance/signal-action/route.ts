/**
 * POST /api/governance/signal-action  (contract §5.2)
 * A governance ruling / "mark actioned" from the Roster (EPI proxies with GOV_API_KEY). EPI records
 * a gov_intervention on its side, then syncs it here (gov_intervention_ref) to close the CDMSS
 * thread. CDMSS never enacts enforcement — it stores the ruling reference + updates status.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { getByReference, getBySignalId, applySignalAction, toSignalRow } from '@/lib/opd-gov-signal-store';
import { validateSignalAction, signalObject, type SignalActionInput } from '@/lib/opd-gov-signal-core';
import { resolveInstances } from '@/lib/opd-gov-read';

export async function POST(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: SignalActionInput;
  try { body = (await req.json()) as SignalActionInput; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const signal = body.signal_id ? await getBySignalId(body.signal_id) : body.reference ? await getByReference(body.reference) : null;
  if (!signal) return NextResponse.json({ ok: false, error: 'unknown reference' }, { status: 404 });

  const v = validateSignalAction(body);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  const updated = await applySignalAction(signal, v.value);
  const now = new Date().toISOString();
  const { count, representative } = await resolveInstances(updated.doctor_uid, updated.signal_type, updated.window_from, updated.window_to);
  return NextResponse.json({ ok: true, status: updated.status, signal: signalObject(toSignalRow(updated, count), representative, now) });
}
