/**
 * lib/triage/ds-lander.ts — discharge-summary audit → Action-queue cards (pure).
 *
 * ATTRIBUTION (fail closed). `ipd_discharge_audits` has no doctor_uid. The only
 * identity this lander will put on a card is the uid `fetchIpdDoctorHop` already
 * resolved: `kx_ip_admissions.current_treating_doctor_id` → the practitioner-id
 * union on `doctors` → one `doctors.uid`. That uid is the same namespace as
 * `opd_note_audits.doctor_uid` / `physicians.cdmss_doctor_uid`. This file does
 * not read a name, does not call the IPD list's name chrome, and does not invent
 * a uid when the hop is missing, ambiguous, unmatched, or unavailable.
 *
 * Unresolved stays become queue cards with `doctor_uid: null` and a queue-local
 * ref `discharge_summary|unmapped:<audit_id>|<signal_type>`. The stamp door
 * accepts only `hold` + reason `unmapped_doctor` for that ref. The marker is not
 * a physician.
 *
 * Admin IPD review (`ipd_audit_feedback`) is a different surface. This lander
 * only bridges findings onto the shared Action queue.
 */

import { stampFindingIdentity, type OpdFinding } from '@/lib/opd-note-audit-core';
import { importanceHint, severityOf, type TriageFinding, type TriageRepresentative } from '@/lib/opd-triage-core';
import { actionQueueItemRef } from '@/lib/triage/shadow-schema';
import { unmappedQueueDoctor } from '@/lib/triage/note-class';

export interface DischargeAuditSource {
  id: string;
  ip_uid?: string | null;
  speciality?: string | null;
  note_date: string;
  findings: unknown;
}

export interface DischargeHopView {
  byIpUid: Record<string, { doctorUid: string | null; reason: string }>;
  coverage: { unavailable: boolean };
}

export interface UnmappedDischargeCard {
  queue_item_ref: string;
  note_class: 'discharge_summary';
  doctor_uid: null;
  attribution: 'unmapped';
  hop_reason: string;
  signal_type: string;
  label: string;
  count: number;
  notes: number;
  importance_hint: 'low' | 'med' | 'high';
  audit_id: string;
  speciality: string | null;
  representative: TriageRepresentative;
}

export interface LandedDischarge {
  findings: TriageFinding[];
  unmapped: UnmappedDischargeCard[];
}

export interface UnmappedDispositionKey {
  scope?: string;
  note_class?: string | null;
  doctor_uid: string;
  signal_type: string;
}

function asFindingArray(value: unknown): Record<string, unknown>[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row) => row && typeof row === 'object') as Record<string, unknown>[];
}

function toOpdFinding(raw: Record<string, unknown>): OpdFinding | null {
  const subject = String(raw.subject ?? '').trim();
  if (!subject) return null;
  const domain = raw.domain === 'prescribing_safety' ? 'prescribing_safety' : 'appropriateness';
  const citation_ids = Array.isArray(raw.citation_ids)
    ? raw.citation_ids.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  return {
    subject,
    verdict: (String(raw.verdict ?? 'uncertain') || 'uncertain') as OpdFinding['verdict'],
    confidence: Number(raw.confidence) || 0,
    domain,
    rationale: String(raw.rationale ?? ''),
    evidence: [],
    estimates: [],
    citation_ids,
    source: 'llm',
  };
}

function representativeOf(f: TriageFinding): TriageRepresentative {
  return {
    audit_id: f.audit_id,
    finding_ref: f.finding_ref,
    subject: f.subject,
    verdict: f.verdict,
    rationale: f.rationale,
    note_date: (f.note_date || '').slice(0, 10),
    citation_ids: f.citation_ids ?? [],
    complexity_band: null,
    complexity_inputs: null,
    lvc_category: f.lvc_category ?? null,
  };
}

interface Attribution { doctorUid: string | null; reason: string }

function attribute(ipUid: string, hop: DischargeHopView): Attribution {
  if (hop.coverage.unavailable) return { doctorUid: null, reason: 'hop_unavailable' };
  if (!ipUid) return { doctorUid: null, reason: 'no_ip_uid' };
  const row = hop.byIpUid[ipUid];
  if (!row || row.reason !== 'resolved' || !row.doctorUid) {
    return { doctorUid: null, reason: row?.reason || 'unmatched_practitioner' };
  }
  return { doctorUid: row.doctorUid, reason: 'resolved' };
}

/**
 * Turn canonical discharge-audit rows into mapped findings (real uid) and
 * unmapped cards (no uid). Name-shaped fields on the row are ignored.
 */
export function landDischargeAudits(rows: readonly DischargeAuditSource[], hop: DischargeHopView): LandedDischarge {
  const findings: TriageFinding[] = [];
  const unmappedBuckets = new Map<string, { card: UnmappedDischargeCard; count: number }>();

  for (const row of rows ?? []) {
    const audit_id = String(row?.id ?? '').trim();
    if (!audit_id) continue;
    const ipUid = String(row?.ip_uid ?? '').trim();
    const note_date = String(row?.note_date ?? '').slice(0, 10);
    const speciality = row?.speciality == null || String(row.speciality).trim() === '' ? null : String(row.speciality);
    const stamped = stampFindingIdentity(asFindingArray(row.findings).map(toOpdFinding).filter((f): f is OpdFinding => !!f));
    const attr = attribute(ipUid, hop);

    for (const f of stamped) {
      if (!f.signal_type || !f.finding_ref) continue;
      if (f.informational) continue;
      const base: TriageFinding = {
        audit_id,
        doctor_uid: attr.doctorUid ?? '',
        note_date,
        subject: f.subject,
        rationale: f.rationale,
        verdict: f.verdict,
        domain: f.domain,
        signal_type: f.signal_type,
        finding_ref: f.finding_ref,
        citation_ids: f.citation_ids,
        note_class: 'discharge_summary',
      };
      if (attr.doctorUid) {
        base.doctor_uid = attr.doctorUid;
        findings.push(base);
        continue;
      }
      const marker = unmappedQueueDoctor(audit_id);
      const key = `${marker}\0${f.signal_type}`;
      const existing = unmappedBuckets.get(key);
      if (existing) {
        existing.count += 1;
        existing.card.count = existing.count;
        continue;
      }
      const weight = severityOf(f.signal_type);
      unmappedBuckets.set(key, {
        count: 1,
        card: {
          queue_item_ref: actionQueueItemRef(marker, f.signal_type, 'discharge_summary'),
          note_class: 'discharge_summary',
          doctor_uid: null,
          attribution: 'unmapped',
          hop_reason: attr.reason,
          signal_type: f.signal_type,
          label: f.subject.split(':')[0]?.trim() || f.signal_type,
          count: 1,
          notes: 1,
          importance_hint: importanceHint(weight),
          audit_id,
          speciality,
          representative: representativeOf({ ...base, doctor_uid: '' }),
        },
      });
    }
  }

  return { findings, unmapped: [...unmappedBuckets.values()].map((b) => b.card) };
}

/** Hold/drop on the queue-local marker clears that unmapped card only. An OPD
 *  decision for another uid, or a discharge decision for a different stay, does not. */
export function visibleUnmappedCards(
  cards: readonly UnmappedDischargeCard[],
  decisions: readonly UnmappedDispositionKey[],
  status: 'untriaged' | 'all',
): UnmappedDischargeCard[] {
  if (status === 'all') return [...cards];
  const hidden = new Set<string>();
  for (const d of decisions) {
    if (d.scope != null && d.scope !== 'type') continue;
    if (d.note_class !== 'discharge_summary') continue;
    if (!d.doctor_uid || !d.signal_type) continue;
    hidden.add(`${d.doctor_uid}\0${d.signal_type}`);
  }
  return cards.filter((card) => !hidden.has(`${unmappedQueueDoctor(card.audit_id)}\0${card.signal_type}`));
}
