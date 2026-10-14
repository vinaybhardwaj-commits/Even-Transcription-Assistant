/**
 * POST /api/governance/doctor-response  (contract §5.1)
 * The doctor's answer to a routed signal, from the portal (EPI proxies with GOV_API_KEY). Type must
 * match the signal's response_required; an explanation needs a comment + agree/disagree. A `disagree`
 * escalates the thread back to the CM AND writes to opd_audit_feedback (the calibration corpus).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { getByReference, getBySignalId, applyDoctorResponse, toSignalRow } from '@/lib/opd-gov-signal-store';
import { validateDoctorResponse, signalObject, type DoctorResponseInput } from '@/lib/opd-gov-signal-core';
import { resolveInstances } from '@/lib/opd-gov-read';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function POST(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: DoctorResponseInput;
  try { body = (await req.json()) as DoctorResponseInput; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const signal = body.signal_id ? await getBySignalId(body.signal_id) : body.reference ? await getByReference(body.reference) : null;
  if (!signal) return NextResponse.json({ ok: false, error: 'unknown reference' }, { status: 404 });

  const v = validateDoctorResponse(body, signal);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: v.code });

  const updated = await applyDoctorResponse(signal, v.value);

  // A disagree feeds the calibration corpus (opd_audit_feedback), keyed on the representative note.
  if (v.value.type === 'explanation' && v.value.verdict === 'disagree') {
    try {
      const { representative } = await resolveInstances(signal.doctor_uid, signal.signal_type, signal.window_from, signal.window_to);
      if (representative?.audit_id) {
        await run(
          `INSERT INTO opd_audit_feedback (app_source, audit_id, uid, verdict, comment, author)
           VALUES ('standalone', $1::uuid, $2, 'disagree', $3, $4)`,
          [representative.audit_id, null, v.value.comment, `doctor:${signal.doctor_uid}`]);
      }
    } catch { /* calibration write is best-effort; the response is already recorded */ }
  }

  const now = new Date().toISOString();
  const { count, representative } = await resolveInstances(updated.doctor_uid, updated.signal_type, updated.window_from, updated.window_to);
  return NextResponse.json({ ok: true, status: updated.status, signal: signalObject(toSignalRow(updated, count), representative, now) });
}
