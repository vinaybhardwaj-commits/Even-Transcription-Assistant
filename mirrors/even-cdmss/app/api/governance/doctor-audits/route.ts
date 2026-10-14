/**
 * GET /api/governance/doctor-audits?doctor_uid=&window=30&status=open
 * The doctor-portal feed (contract §4.1): one physician's own routed audit-signal threads + their
 * audit metrics. EPI proxies this server-side with GOV_API_KEY, resolving its session physician →
 * doctor_uid. Only CM-routed threads appear — never a raw/audit_bug/un-routed finding.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { fetchDoctorNames } from '@/lib/metabase';
import { listSignalsForDoctor, toSignalRow } from '@/lib/opd-gov-signal-store';
import { signalObject } from '@/lib/opd-gov-signal-core';
import { resolveInstances, doctorAuditMetrics } from '@/lib/opd-gov-read';
import { getOperationalBlock } from '@/lib/doctor-metrics-store';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const doctorUid = (sp.get('doctor_uid') || '').trim();
  if (!doctorUid) return NextResponse.json({ ok: false, error: 'doctor_uid required' }, { status: 400 });
  const days = Math.max(1, Math.min(120, Number(sp.get('window')) || 30));
  const status = sp.get('status') === 'all' ? 'all' : 'open';
  const now = new Date().toISOString();

  const [signals, metrics, operational, names, dir] = await Promise.all([
    listSignalsForDoctor(doctorUid, status),
    doctorAuditMetrics(doctorUid, days),
    getOperationalBlock(doctorUid).catch(() => null),
    fetchDoctorNames([doctorUid]).catch(() => ({} as Record<string, string>)),
    run(`SELECT speciality FROM doctor_directory WHERE doctor_uid=$1 LIMIT 1`, [doctorUid]).catch(() => []),
  ]);

  const out = [];
  for (const s of signals) {
    const { count, representative } = await resolveInstances(s.doctor_uid, s.signal_type, s.window_from, s.window_to);
    out.push(signalObject(toSignalRow(s, count), representative, now));
  }

  return NextResponse.json({
    ok: true,
    doctor: { uid: doctorUid, name: names[doctorUid] || undefined, speciality: dir[0]?.speciality ? String(dir[0].speciality) : undefined },
    window: { days },
    // Audit-led; operational folded in (null when the doctor has no matview row). EPI gates the
    // operational block on link confidence portal-side (contract §7b.1 misattribution safeguard).
    metrics: { audit: metrics, operational },
    signals: out,
    advisory: 'Advisory documentation & prescribing signals validated by a care manager — not a performance score.',
  });
}
