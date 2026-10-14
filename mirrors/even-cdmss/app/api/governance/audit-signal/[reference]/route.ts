/**
 * GET /api/governance/audit-signal/{reference}
 * One thread's full detail (contract §4.3): the signal object + all finding instances + the ordered
 * append-only event log (the auditable trail).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { getByReference, listEvents, toSignalRow } from '@/lib/opd-gov-signal-store';
import { signalObject, isAuditRef } from '@/lib/opd-gov-signal-core';
import { resolveInstances } from '@/lib/opd-gov-read';

export async function GET(req: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const { reference: rawRef } = await params;
  const reference = decodeURIComponent(rawRef || '');
  if (!isAuditRef(reference)) return NextResponse.json({ ok: false, error: 'bad reference' }, { status: 400 });

  const signal = await getByReference(reference);
  if (!signal) return NextResponse.json({ ok: false, error: 'unknown reference' }, { status: 404 });

  const now = new Date().toISOString();
  const [{ count, representative, instances }, events] = await Promise.all([
    resolveInstances(signal.doctor_uid, signal.signal_type, signal.window_from, signal.window_to),
    listEvents(signal.signal_id),
  ]);

  return NextResponse.json({
    ok: true,
    signal: signalObject(toSignalRow(signal, count), representative, now),
    instances,
    events,
  });
}
