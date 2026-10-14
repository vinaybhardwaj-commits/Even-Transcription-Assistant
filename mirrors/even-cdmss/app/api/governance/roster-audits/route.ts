/**
 * GET /api/governance/roster-audits?window=30&status=&importance=&response_required=&doctor_uid=
 * The Roster feed (contract §4.2): governance-wide thread list (or one physician's, with
 * ?doctor_uid=, for the profile Signals tab) + counts. Governance-wide stays light (no per-signal
 * instance scan); the per-doctor view resolves representatives.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { fetchDoctorNames } from '@/lib/metabase';
import { sql } from '@/lib/db';
import { listSignalsRoster, toSignalRow, type StoredSignal } from '@/lib/opd-gov-signal-store';
import { signalObject, isOverdue } from '@/lib/opd-gov-signal-core';
import { resolveInstances, doctorAuditMetrics } from '@/lib/opd-gov-read';
import { getOperationalBlocks, type OperationalBlock } from '@/lib/doctor-metrics-store';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const doctorUid = (sp.get('doctor_uid') || '').trim();
  const now = new Date().toISOString();

  const signals = await listSignalsRoster({
    doctorUid: doctorUid || undefined,
    status: sp.get('status') || undefined,
    importance: sp.get('importance') || undefined,
    response_required: sp.get('response_required') || undefined,
  });

  const counts = { routed: 0, responded: 0, overdue: 0, escalated: 0, awaiting_ruling: 0 };
  for (const s of signals) {
    if (s.status === 'routed') counts.routed++;
    if (s.status === 'responded') counts.responded++;
    if (s.status === 'escalated') { counts.escalated++; counts.awaiting_ruling++; }
    if (isOverdue({ status: s.status, response_required: s.response_required, sla_due_at: s.sla_due_at }, now)) counts.overdue++;
  }

  // group by doctor
  const byDoc = new Map<string, StoredSignal[]>();
  for (const s of signals) (byDoc.get(s.doctor_uid) || byDoc.set(s.doctor_uid, []).get(s.doctor_uid)!).push(s);
  const [names, specRows, operationalBlocks] = await Promise.all([
    fetchDoctorNames([...byDoc.keys()]).catch(() => ({} as Record<string, string>)),
    run(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []).catch(() => []),
    getOperationalBlocks([...byDoc.keys()]).catch(() => ({} as Record<string, OperationalBlock>)),
  ]);
  const spec: Record<string, string> = {};
  for (const r of specRows as Record<string, unknown>[]) spec[String(r.doctor_uid)] = String(r.speciality);

  const doctors = [];
  for (const [uid, list] of byDoc.entries()) {
    const open = list.filter((s) => ['routed', 'responded', 'escalated'].includes(s.status)).length;
    const overdue = list.filter((s) => isOverdue({ status: s.status, response_required: s.response_required, sla_due_at: s.sla_due_at }, now)).length;
    const awaiting = list.filter((s) => s.status === 'escalated').length;
    const sigObjs = [];
    for (const s of list) {
      // resolve representatives only for the focused profile view (?doctor_uid=)
      const inst = doctorUid ? await resolveInstances(s.doctor_uid, s.signal_type, s.window_from, s.window_to) : { count: null, representative: null };
      sigObjs.push(signalObject(toSignalRow(s, inst.count), inst.representative, now));
    }
    // operational folded in (batch, cheap); audit metrics only for the focused profile view
    const metrics: Record<string, unknown> = { operational: operationalBlocks[uid] ?? null };
    if (doctorUid) metrics.audit = await doctorAuditMetrics(uid, Math.max(1, Math.min(120, Number(sp.get('window')) || 30)));
    doctors.push({ doctor_uid: uid, name: names[uid] || undefined, speciality: spec[uid] || undefined, open, overdue, awaiting_ruling: awaiting, metrics, signals: sigObjs });
  }
  doctors.sort((a, b) => (b.awaiting_ruling - a.awaiting_ruling) || (b.overdue - a.overdue) || (b.open - a.open));

  return NextResponse.json({
    ok: true, window: { days: Math.max(1, Math.min(120, Number(sp.get('window')) || 30)) },
    counts, doctors,
    advisory: 'Advisory governance signals validated by a care manager — supportive follow-up, not a clinician score.',
  });
}
