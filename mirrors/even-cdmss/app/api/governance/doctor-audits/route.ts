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
import { isNoteClass } from '@/lib/triage/note-class';
import { resolveInstances, resolveInstancesForNoteClass, doctorAuditMetrics } from '@/lib/opd-gov-read';
import { getOperationalBlock } from '@/lib/doctor-metrics-store';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const doctorUid = (sp.get('doctor_uid') || '').trim();
  if (!doctorUid) return NextResponse.json({ ok: false, error: 'doctor_uid required' }, { status: 400 });
  const days = Math.max(1, Math.min(120, Number(sp.get('window')) || 30));
  const status = sp.get('status') === 'all' ? 'all' : 'open';
  const noteClassParam = (sp.get('note_class') || '').trim();
  if (noteClassParam && !isNoteClass(noteClassParam)) {
    return NextResponse.json({ ok: false, error: 'note_class must be opd|discharge_summary|ot' }, { status: 400 });
  }
  const now = new Date().toISOString();

  const [signals, metrics, operational, names, dir] = await Promise.all([
    listSignalsForDoctor(doctorUid, status),
    doctorAuditMetrics(doctorUid, days),
    getOperationalBlock(doctorUid).catch(() => null),
    fetchDoctorNames([doctorUid]).catch(() => ({} as Record<string, string>)),
    run(`SELECT speciality FROM doctor_directory WHERE doctor_uid=$1 LIMIT 1`, [doctorUid]).catch(() => []),
  ]);

  const signalsForClass = noteClassParam
    ? signals.filter((s) => s.note_class === noteClassParam)
    : signals;

  const out = [];
  const sourceRefs = signalsForClass.map((s) => s.source_triage_ref).filter((v): v is string => !!v);
  const triageRows = sourceRefs.length
    ? await run(
        `SELECT DISTINCT ON (decision_id)
           decision_id::text AS decision_id, reason, policy_version
         FROM triage_stamp_events
         WHERE decision_id = ANY($1::uuid[]) AND outcome IN ('applied','decision_recorded_signal_failed')
         ORDER BY decision_id, created_at DESC`,
        [sourceRefs],
      ).catch(() => [])
    : [];
  const triageMeta = new Map(triageRows.map((row) => [
    String(row.decision_id),
    {
      rationale: row.reason == null ? null : String(row.reason),
      policy_version: row.policy_version == null ? null : String(row.policy_version),
    },
  ]));
  for (const s of signalsForClass) {
    // Class-scoped stores. OPD text must not attach to a discharge or OT thread that shares a
    // signal_type, and those classes must not stay hardcoded at zero when their own audits match.
    const { count, representative } = s.note_class === 'opd'
      ? await resolveInstances(s.doctor_uid, s.signal_type, s.window_from, s.window_to)
      : await resolveInstancesForNoteClass(s.note_class, s.doctor_uid, s.signal_type, s.window_from, s.window_to);
    const signal = signalObject(toSignalRow(s, count), representative, now);
    out.push({
      ...signal,
      triage: s.source_triage_ref ? triageMeta.get(s.source_triage_ref) ?? null : null,
    });
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
