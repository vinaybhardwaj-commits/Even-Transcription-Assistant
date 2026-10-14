/**
 * lib/triage/queue-read.ts — the ONE Action-queue population.
 *
 * Same read the /care/triage UI uses (GET /api/opd-triage/queue). Informational findings are
 * dropped by buildQueue — this module does not invent a second queue or a second filter.
 *
 * Discharge summaries from ipd_discharge_audits join the same population with
 * note_class=discharge_summary. Doctor identity is the treating-doctor hop only.
 * Unjoined stays are queued as unmapped cards, never under an invented uid.
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
import { fetchIpdDoctorHop } from '@/lib/ipd-doctor-hop';
import { actionQueueItemRef } from '@/lib/triage/shadow-schema';
import { noteClassOf, unmappedQueueDoctor, type NoteClass } from '@/lib/triage/note-class';
import {
  landDischargeAudits, visibleUnmappedCards,
  type DischargeAuditSource, type UnmappedDischargeCard,
} from '@/lib/triage/ds-lander';

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
  /** Discharge stays the treating-doctor hop did not resolve. Not grouped under a physician. */
  unmapped: UnmappedDischargeCard[];
  advisory: string;
}

export interface ActionQueueItem {
  queue_item_ref: string;
  note_class: NoteClass;
  /** Null on an unmapped discharge card. Never a synthesized physician id. */
  doctor_uid: string | null;
  attribution: 'mapped' | 'unmapped';
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

/** Flatten the CM Action queue (doctor → class → signal_type, plus unmapped discharge cards). */
export function flattenActionQueueItems(
  doctors: DoctorGroup[],
  unmapped: UnmappedDischargeCard[] = [],
): ActionQueueItem[] {
  const items: ActionQueueItem[] = [];
  for (const d of doctors) {
    for (const t of d.types) {
      const note_class = noteClassOf(t.note_class);
      items.push({
        queue_item_ref: actionQueueItemRef(d.doctor_uid, t.signal_type, note_class),
        note_class,
        doctor_uid: d.doctor_uid,
        attribution: 'mapped',
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
  for (const card of unmapped) {
    items.push({
      queue_item_ref: card.queue_item_ref,
      note_class: 'discharge_summary',
      doctor_uid: null,
      attribution: 'unmapped',
      doctor_name: null,
      speciality: card.speciality,
      signal_type: card.signal_type,
      label: card.label,
      count: card.count,
      notes: card.notes,
      importance_hint: card.importance_hint,
      representative: card.representative,
      triage: null,
    });
  }
  return items;
}

async function loadDischargeQueue(from: string, to: string): Promise<{ findings: TriageFinding[]; unmapped: UnmappedDischargeCard[] }> {
  const where = `app_source = $1 AND engine_version LIKE 'ipd-discharge-audit/%' AND engine_version NOT LIKE '%-mini'
    AND discharged_at IS NOT NULL AND (discharged_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`;
  const rows = await run(
    `SELECT id, ip_uid, speciality, note_date, findings
     FROM (${canonicalDistinctOnSql({
       table: 'ipd_discharge_audits',
       identity: 'document_id',
       cols: `id::text AS id, ip_uid, speciality,
              to_char((discharged_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS note_date,
              findings`,
       where,
     })}) canonical
     LIMIT 8000`,
    [APP, from, to],
  );
  const sources: DischargeAuditSource[] = (rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    ip_uid: r.ip_uid == null ? null : String(r.ip_uid),
    speciality: r.speciality == null ? null : String(r.speciality),
    note_date: String(r.note_date || ''),
    findings: r.findings,
  }));
  if (!sources.length) return { findings: [], unmapped: [] };
  let hop: Awaited<ReturnType<typeof fetchIpdDoctorHop>>;
  try {
    hop = await fetchIpdDoctorHop(sources.map((s) => s.ip_uid || ''));
  } catch {
    hop = { byIpUid: {}, coverage: { asked: sources.length, known: 0, resolved: 0, ambiguousPractitioner: 0, ambiguousStay: 0, unmatched: 0, noTreatingId: 0, unavailable: true }, ambiguousIds: [] };
  }
  return landDischargeAudits(sources, hop);
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
        note_class: 'opd',
        complexity_band: band, complexity_inputs: inputs,
        lvc_category: (f as { lvc_category?: string }).lvc_category ?? null,
        quieted_by: (f as { quieted_by?: string | null }).quieted_by ?? null,
      });
    }
  }

  let dischargeFindings: TriageFinding[] = [];
  let dischargeUnmapped: UnmappedDischargeCard[] = [];
  try {
    const landed = await loadDischargeQueue(from, to);
    dischargeFindings = doctorFilter
      ? landed.findings.filter((f) => f.doctor_uid === doctorFilter)
      : landed.findings;
    dischargeUnmapped = doctorFilter ? [] : landed.unmapped;
  } catch {
    dischargeFindings = [];
    dischargeUnmapped = [];
  }
  findings.push(...dischargeFindings);

  const doctorUids = [...new Set([
    ...findings.map((f) => f.doctor_uid),
    ...dischargeUnmapped.map((card) => unmappedQueueDoctor(card.audit_id)),
  ])];
  const [decisions, names, dirRows] = await Promise.all([
    loadTriageDecisions(doctorUids).catch(() => []),
    fetchDoctorNames(doctorUids).catch(() => ({} as Record<string, string>)),
    run(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []).catch(() => []),
  ]);
  const specialities: Record<string, string> = {};
  for (const r of dirRows as Record<string, unknown>[]) specialities[String(r.doctor_uid)] = String(r.speciality);

  const { doctors } = buildQueue(findings, decisions, { names, specialities, status, includeQuieted });
  const unmapped = visibleUnmappedCards(dischargeUnmapped, decisions, status);

  return {
    ok: true,
    window: { from, to, days },
    status,
    engine: OPD_ENGINE_VERSION,
    doctors_total: doctorUids.length,
    doctors,
    unmapped,
    advisory: 'Advisory documentation & prescribing signals from an automated screen — validate before routing. Not a clinician performance score.',
  };
}
