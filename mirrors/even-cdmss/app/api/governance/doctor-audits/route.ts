
/**
 * GET /api/governance/doctor-audits?doctor_uid=&window=30&status=open
 * The doctor-portal feed (contract §4.1): one physician's own routed audit-signal threads + their
 * audit metrics. EPI proxies this server-side with GOV_API_KEY, resolving its session physician →
 * doctor_uid. Only CM-routed threads appear — never a raw/audit_bug/un-routed finding.
 *
 * DOCTOR-FACING PAYLOAD. Every object below is built from the explicit allowlist in
 * lib/doctor-facing.ts. Triage stamps (rationale, policy version), rulings, importance and engine
 * versions are not in it and cannot reach this response by being added to a governance object.
 * Governance staff read those from roster-audits and audit-signal/{reference}.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { govKeyValid } from '@/lib/gov-auth';
import { fetchDoctorNames } from '@/lib/metabase';
import { listSignalsForDoctor, toSignalRow } from '@/lib/opd-gov-signal-store';
import { signalObject, isDoctorVisibleThread } from '@/lib/opd-gov-signal-core';
import { isNoteClass, type NoteClass } from '@/lib/triage/note-class';
import { resolveInstancesForSignal, doctorAuditMetrics } from '@/lib/opd-gov-read';
import { getOperationalBlock } from '@/lib/doctor-metrics-store';
import {
  DOCTOR_ADVISORY, doctorAuditMetrics as doctorMetrics, doctorInstance, doctorSignal,
} from '@/lib/doctor-facing';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** `discharge` is the doctor-facing spelling of the internal `discharge_summary`; both are accepted. */
function parseNoteClassParam(raw: string): NoteClass | null | 'bad' {
  if (!raw) return null;
  if (raw === 'discharge') return 'discharge_summary';
  return isNoteClass(raw) ? raw : 'bad';
}

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const doctorUid = (sp.get('doctor_uid') || '').trim();
  if (!doctorUid) return NextResponse.json({ ok: false, error: 'doctor_uid required' }, { status: 400 });
  const days = Math.max(1, Math.min(120, Number(sp.get('window')) || 30));
  const status = sp.get('status') === 'all' ? 'all' : 'open';
  const noteClassParam = parseNoteClassParam((sp.get('note_class') || '').trim());
  if (noteClassParam === 'bad') {
    return NextResponse.json({ ok: false, error: 'note_class must be opd|discharge|ot' }, { status: 400 });
  }
  const now = new Date().toISOString();

  const [signals, metrics, operational, names, dir] = await Promise.all([
    listSignalsForDoctor(doctorUid, status),
    doctorAuditMetrics(doctorUid, days),
    getOperationalBlock(doctorUid).catch(() => null),
    fetchDoctorNames([doctorUid]).catch(() => ({} as Record<string, string>)),
    run(`SELECT speciality FROM doctor_directory WHERE doctor_uid=$1 LIMIT 1`, [doctorUid]).catch(() => []),
  ]);

  // Doctor-visible = routed to this doctor and neither withdrawn by the care manager nor dismissed by
  // governance. Those threads are omitted, not returned with routed=false (the same predicate gates
  // the export and the routed-only PDF). A thread the doctor already answered stays, response and all.
  const signalsForClass = signals
    .filter((s) => isDoctorVisibleThread(s))
    .filter((s) => !noteClassParam || s.note_class === noteClassParam);

  const out = [];
  for (const s of signalsForClass) {
    // Each thread resolves against its own note class: an OPD note never attaches to a discharge or
    // OT thread that shares a signal_type. `enrich` adds evidence, citations and patient context.
    const { count, representative } = await resolveInstancesForSignal(s, { enrich: true });
    const signal = signalObject(toSignalRow(s, count), representative, now);
    // Every instance of a thread is, by construction, a finding of its own routed signal_type.
    out.push(doctorSignal(signal, representative ? doctorInstance(representative, s.note_class, true) : null));
  }

  return NextResponse.json({
    ok: true,
    doctor: { uid: doctorUid, name: names[doctorUid] || undefined, speciality: dir[0]?.speciality ? String(dir[0].speciality) : undefined },
    window: { days },
    // Audit-led; operational folded in (null when the doctor has no matview row). EPI gates the
    // operational block on link confidence portal-side (contract §7b.1 misattribution safeguard).
    metrics: { audit: doctorMetrics(metrics as unknown as Record<string, unknown>), operational },
    signals: out,
    advisory: DOCTOR_ADVISORY,
  });
}
