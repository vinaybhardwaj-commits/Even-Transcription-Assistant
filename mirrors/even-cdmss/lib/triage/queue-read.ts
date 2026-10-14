/**
 * lib/triage/queue-read.ts — the ONE Action-queue population.
 *
 * Same read the /care/triage UI uses (GET /api/opd-triage/queue). Informational findings are
 * dropped by buildQueue — this module does not invent a second queue or a second filter.
 */

import { sql } from '@/lib/db';
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT, stampFindingIdentity, type OpdFinding } from '@/lib/opd-note-audit-core';
import { fetchDoctorNames } from '@/lib/metabase';
import { parseJson } from '@/lib/opd-audit-ui';
import { buildQueue, type DoctorGroup, type TriageFinding } from '@/lib/opd-triage-core';
import { loadTriageDecisions } from '@/lib/opd-triage-store';
import { stripRetiredEvenCitations } from '@/lib/even-ground-core';
import type { Source } from '@/lib/citations-core';
import { actionQueueItemRef } from '@/lib/triage/shadow-schema';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';
const ENGINE_FAMILY: string[] = [...OPD_ENGINE_VERSIONS_CURRENT];

export type ActionQueueStatus = 'untriaged' | 'all';

export interface ActionQueueQuery {
  day: string;
  days: number;
  doctor_uid: string;
  status: ActionQueueStatus;
  includeQuieted: boolean;
}

export interface ActionQueueResult {
  ok: true;
  window: { from: string; to: string; days: number };
  status: ActionQueueStatus;
  engine: string;
  doctors_total: number;
  doctors: DoctorGroup[];
  advisory: string;
}

export interface ActionQueueItem {
  queue_item_ref: string;
  doctor_uid: string;
  doctor_name: string | null;
  speciality: string | null;
  signal_type: string;
  label: string;
  count: number;
  notes: number;
  importance_hint: string;
  representative: DoctorGroup['types'][number]['representative'];
  triage: DoctorGroup['types'][number]['triage'];
}

type QueryBag = { get(name: string): string | null } | Record<string, unknown>;

function bagGet(input: QueryBag, name: string): string | null {
  if (typeof (input as { get?: unknown }).get === 'function') {
    return (input as { get: (n: string) => string | null }).get(name);
  }
  const v = (input as Record<string, unknown>)[name];
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

export function parseActionQueueQuery(input: QueryBag): ActionQueueQuery {
  const status = bagGet(input, 'status') === 'all' ? 'all' : 'untriaged';
  const doctor_uid = (bagGet(input, 'doctor_uid') || '').trim();
  const days = Math.max(1, Math.min(7, Number(bagGet(input, 'days')) || 1));
  const quieted = bagGet(input, 'quieted');
  const includeQuieted = quieted === '1' || quieted === 'true';
  const day = (bagGet(input, 'day') || '').trim();
  return { day, days, doctor_uid, status, includeQuieted };
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Flatten the CM Action queue (doctor → signal_type cards) into bot-addressable items. */
export function flattenActionQueueItems(doctors: DoctorGroup[]): ActionQueueItem[] {
  const items: ActionQueueItem[] = [];
  for (const d of doctors) {
    for (const t of d.types) {
      items.push({
        queue_item_ref: actionQueueItemRef(d.doctor_uid, t.signal_type),
        doctor_uid: d.doctor_uid,
        doctor_name: d.name ?? null,
        speciality: d.speciality ?? null,
        signal_type: t.signal_type,
        label: t.label,
        count: t.count,
        notes: t.notes,
        importance_hint: t.importance_hint,
        representative: t.representative,
        triage: t.triage,
      });
    }
  }
  return items;
}

/**
 * Last night's non-informational OPD audit findings, grouped by doctor → signal_type, ranked by
 * severity × noise, with the current triage decision overlaid. Identical population to the UI.
 */
export async function readActionQueue(query: ActionQueueQuery): Promise<ActionQueueResult> {
  const status = query.status === 'all' ? 'all' : 'untriaged';
  const doctorFilter = (query.doctor_uid || '').trim();
  const days = Math.max(1, Math.min(7, Number(query.days) || 1));
  const includeQuieted = !!query.includeQuieted;

  let day = query.day || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const latest = await run(
      `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d
       FROM opd_note_audits WHERE app_source = $1 AND engine_version = ANY($2) AND excluded_reason IS NULL`,
      [APP, ENGINE_FAMILY]).catch(() => []);
    day = String(latest[0]?.d || new Date().toISOString().slice(0, 10));
  }
  const from = addDays(day, -(days - 1));
  const to = day;

  const params: unknown[] = [APP, ENGINE_FAMILY, from, to];
  let where = `app_source = $1 AND engine_version = ANY($2) AND excluded_reason IS NULL AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $3 AND $4`;
  if (doctorFilter) { params.push(doctorFilter); where += ` AND doctor_uid = $${params.length}`; }

  const retiredEvenIds = (await run(`SELECT id FROM even_lvc_assertions WHERE status = 'retired'`, []).catch(() => []))
    .map((r) => String((r as Record<string, unknown>).id));
  const srcCol = retiredEvenIds.length ? ', sources' : '';

  const rows = await run(
    `SELECT id, doctor_uid, note_date, findings, complexity_band, complexity_inputs${srcCol}
     FROM (${canonicalDistinctOnSql({
       table: 'opd_note_audits',
       identity: 'uid',
       cols: `id::text AS id, doctor_uid, to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date,
            findings, complexity_band, complexity_inputs${srcCol}`,
       where,
     })}) canonical
     LIMIT 8000`, params).catch(() => []);

  const findings: TriageFinding[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const audit_id = String(r.id);
    const doctor_uid = r.doctor_uid ? String(r.doctor_uid) : '';
    const note_date = String(r.note_date || day);
    if (!doctor_uid) continue;
    const raw = parseJson<OpdFinding[]>(r.findings, []);
    let stamped = stampFindingIdentity(raw);
    if (retiredEvenIds.length) {
      stamped = stripRetiredEvenCitations(stamped, parseJson<Source[]>(r.sources, []), retiredEvenIds).findings;
    }
    const band = r.complexity_band == null ? null : String(r.complexity_band);
    const inputs = r.complexity_inputs == null ? null : parseJson<Record<string, unknown>>(r.complexity_inputs, {});
    for (const f of stamped) {
      findings.push({
        audit_id, doctor_uid, note_date,
        subject: f.subject, rationale: f.rationale, verdict: f.verdict, domain: f.domain,
        signal_type: f.signal_type as string, finding_ref: f.finding_ref as string,
        informational: f.informational, citation_ids: f.citation_ids,
        complexity_band: band, complexity_inputs: inputs,
        lvc_category: (f as { lvc_category?: string }).lvc_category ?? null,
        quieted_by: (f as { quieted_by?: string | null }).quieted_by ?? null,
      });
    }
  }

  const doctorUids = [...new Set(findings.map((f) => f.doctor_uid))];
  const [decisions, names, dirRows] = await Promise.all([
    loadTriageDecisions(doctorUids).catch(() => []),
    fetchDoctorNames(doctorUids).catch(() => ({} as Record<string, string>)),
    run(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []).catch(() => []),
  ]);
  const specialities: Record<string, string> = {};
  for (const r of dirRows as Record<string, unknown>[]) specialities[String(r.doctor_uid)] = String(r.speciality);

  const { doctors } = buildQueue(findings, decisions, { names, specialities, status, includeQuieted });

  return {
    ok: true,
    window: { from, to, days },
    status,
    engine: OPD_ENGINE_VERSION,
    doctors_total: doctorUids.length,
    doctors,
    advisory: 'Advisory documentation & prescribing signals from an automated screen — validate before routing. Not a clinician performance score.',
  };
}
