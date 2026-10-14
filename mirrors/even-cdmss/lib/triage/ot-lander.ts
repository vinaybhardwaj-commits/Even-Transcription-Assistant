/**
 * lib/triage/ot-lander.ts — OT note audit → Action-queue cards (pure).
 *
 * ATTRIBUTION (fail closed). Doctor identity is only the curated surgeon map:
 * free-text surgeon → Pulse doctors.uid. This file never uses the treating-doctor
 * hop, never uses KX *_doctor_id, never name-matches beyond the curated map, and
 * never invents a uid.
 *
 * Unmapped / multi_surgeon_hold rows become queue cards with doctor_uid: null and
 * ref `ot|unmapped:<audit_id>|<signal_type>`. Stamp accepts only hold + unmapped_doctor.
 */

import { stampFindingIdentity, type OpdFinding } from '@/lib/opd-note-audit-core';
import { importanceHint, severityOf, type TriageFinding, type TriageRepresentative } from '@/lib/opd-triage-core';
import { actionQueueItemRef } from '@/lib/triage/shadow-schema';
import { unmappedQueueDoctor } from '@/lib/triage/note-class';
import type { OtMapStatus } from '@/lib/triage/ot-surgeon-map';

export interface OtAuditSource {
  id: string;
  doctor_uid?: string | null;
  map_status?: OtMapStatus | string | null;
  surgeon_raw?: string | null;
  note_day: string;
  findings: unknown;
}

export interface UnmappedOtCard {
  queue_item_ref: string;
  note_class: 'ot';
  doctor_uid: null;
  attribution: 'unmapped';
  hop_reason: string;
  map_status: OtMapStatus;
  signal_type: string;
  label: string;
  count: number;
  notes: number;
  importance_hint: 'low' | 'med' | 'high';
  audit_id: string;
  speciality: string | null;
  representative: TriageRepresentative;
}

export interface LandedOt {
  findings: TriageFinding[];
  unmapped: UnmappedOtCard[];
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

function hopReason(mapStatus: OtMapStatus, doctorUid: string | null): string {
  if (mapStatus === 'multi_surgeon_hold') return 'multi_surgeon_hold';
  if (mapStatus === 'mapped' && doctorUid) return 'resolved';
  return 'unmapped_surgeon';
}

/**
 * Turn OT audit rows into mapped findings (real Pulse uid) and unmapped cards.
 * Treating-doctor / KX doctor ids on the source row are ignored if present.
 */
export function landOtAudits(rows: readonly OtAuditSource[]): LandedOt {
  const findings: TriageFinding[] = [];
  const unmappedBuckets = new Map<string, { card: UnmappedOtCard; count: number }>();

  for (const row of rows ?? []) {
    const audit_id = String(row?.id ?? '').trim();
    if (!audit_id) continue;
    const note_date = String(row?.note_day ?? '').slice(0, 10);
    const map_status = (String(row?.map_status || 'unmapped') as OtMapStatus);
    const doctor_uid = row?.doctor_uid == null || String(row.doctor_uid).trim() === ''
      ? null
      : String(row.doctor_uid).trim();
    const mapped = map_status === 'mapped' && !!doctor_uid;
    const stamped = stampFindingIdentity(asFindingArray(row.findings).map(toOpdFinding).filter((f): f is OpdFinding => !!f));
    const reason = hopReason(map_status === 'multi_surgeon_hold' ? 'multi_surgeon_hold' : (mapped ? 'mapped' : 'unmapped'), doctor_uid);

    for (const f of stamped) {
      if (!f.signal_type || !f.finding_ref) continue;
      if (f.informational) continue;
      const base: TriageFinding = {
        audit_id,
        doctor_uid: doctor_uid ?? '',
        note_date,
        subject: f.subject,
        rationale: f.rationale,
        verdict: f.verdict,
        domain: f.domain,
        signal_type: f.signal_type,
        finding_ref: f.finding_ref,
        citation_ids: f.citation_ids,
        note_class: 'ot',
      };
      if (mapped && doctor_uid) {
        base.doctor_uid = doctor_uid;
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
          queue_item_ref: actionQueueItemRef(marker, f.signal_type, 'ot'),
          note_class: 'ot',
          doctor_uid: null,
          attribution: 'unmapped',
          hop_reason: reason,
          map_status: map_status === 'multi_surgeon_hold' ? 'multi_surgeon_hold' : 'unmapped',
          signal_type: f.signal_type,
          label: f.subject.split(':')[0]?.trim() || f.signal_type,
          count: 1,
          notes: 1,
          importance_hint: importanceHint(weight),
          audit_id,
          speciality: null,
          representative: representativeOf({ ...base, doctor_uid: '' }),
        },
      });
    }
  }

  return { findings, unmapped: [...unmappedBuckets.values()].map((b) => b.card) };
}

/** Hold/drop on the queue-local marker clears that unmapped OT card only. */
export function visibleUnmappedOtCards(
  cards: readonly UnmappedOtCard[],
  decisions: readonly UnmappedDispositionKey[],
  status: 'untriaged' | 'all',
): UnmappedOtCard[] {
  if (status === 'all') return [...cards];
  const hidden = new Set<string>();
  for (const d of decisions) {
    if (d.scope != null && d.scope !== 'type') continue;
    if (d.note_class !== 'ot') continue;
    if (!d.doctor_uid || !d.signal_type) continue;
    hidden.add(`${d.doctor_uid}\0${d.signal_type}`);
  }
  return cards.filter((card) => !hidden.has(`${unmappedQueueDoctor(card.audit_id)}\0${card.signal_type}`));
}
