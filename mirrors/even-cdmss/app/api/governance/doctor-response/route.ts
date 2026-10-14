/**
 * POST /api/governance/doctor-response  (contract §5.1)
 * The doctor's answer to a routed signal, from the portal (EPI proxies with GOV_API_KEY). Type must
 * match the signal's response_required; an explanation needs a comment + agree/disagree. A `disagree`
 * escalates the thread back to the CM AND writes to opd_audit_feedback (the calibration corpus).
 * One response per thread: a repeat of the same answer reads back the current state and writes
 * nothing; a different answer to an answered thread is a 409.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import {
  getByReference,
  getBySignalId,
  applyDoctorResponse,
  claimDoctorResponseRequest,
  completeDoctorResponseRequest,
  ensureDoctorResponseRequestsTable,
  releaseDoctorResponseRequest,
  toSignalRow,
} from '@/lib/opd-gov-signal-store';
import { validateDoctorResponse, classifyDoctorResponse, signalObject, type DoctorResponseInput } from '@/lib/opd-gov-signal-core';
import { resolveInstances } from '@/lib/opd-gov-read';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function POST(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: DoctorResponseInput;
  try { body = (await req.json()) as DoctorResponseInput; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  body.client_request_id = body.client_request_id || req.headers.get('idempotency-key') || undefined;

  const signal = body.signal_id ? await getBySignalId(body.signal_id) : body.reference ? await getByReference(body.reference) : null;
  if (!signal) return NextResponse.json({ ok: false, error: 'unknown reference' }, { status: 404 });

  const v = validateDoctorResponse(body, signal);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: v.code });

  // One response per thread (IG-D1..D3). The persisted request claim makes this race-safe across
  // retries and concurrent requests; the latest_response classifier preserves legacy rows.
  const disposition = classifyDoctorResponse(signal.latest_response, v.value);
  if (disposition === 'conflict') {
    return NextResponse.json({ ok: false, error: 'already responded — revisions go through your care manager' }, { status: 409 });
  }
  try { await ensureDoctorResponseRequestsTable(); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }

  let claim;
  try { claim = await claimDoctorResponseRequest(signal, v.value); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }

  const norm = (value: string | null) => (value || '').trim().replace(/\s+/g, ' ');
  if (!claim.claimed && (claim.verb !== v.value.verb || norm(claim.comment) !== norm(v.value.comment))) {
    return NextResponse.json({ ok: false, error: 'already responded — revisions go through your care manager' }, { status: 409 });
  }

  const replay = disposition === 'replay' || !claim.claimed;
  let updated = signal;
  if (!replay) {
    try {
      updated = await applyDoctorResponse(signal, v.value);
    } catch (e) {
      await releaseDoctorResponseRequest(signal, v.value).catch(() => undefined);
      return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
    }
  } else if (!signal.latest_response) {
    // Another request claimed and completed this thread after our initial read.
    updated = (await getBySignalId(signal.signal_id)) || signal;
  }

  // A disagree feeds the calibration corpus (opd_audit_feedback), keyed on the representative note.
  if (!replay && v.value.verb === 'disagree') {
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

  if (!replay) {
    await completeDoctorResponseRequest(signal, v.value, updated).catch(() => undefined);
  }

  const now = new Date().toISOString();
  const { count, representative } = await resolveInstances(updated.doctor_uid, updated.signal_type, updated.window_from, updated.window_to);
  return NextResponse.json({
    ok: true,
    replayed: replay,
    client_request_id: v.value.client_request_id,
    status: updated.status,
    signal: signalObject(toSignalRow(updated, count), representative, now),
  });
}
