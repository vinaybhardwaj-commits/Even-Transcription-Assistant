// lib/care-call-core.ts — Care-Call Capture pure core (care-call/0.1). The per-episode ask
// generator, the chip→assertion derivation, escalation + outcome validation. No LLM, no I/O.
//
// AMENDMENT A (V-ratified 12 Jul): the assertion vocabulary is the CANONICAL clinical-state/1.2
// vocab — TYPE-ONLY imported (clinical-state is never modified). The base spec's local duplicate
// enums are DELETED; only Care-Call-only enums (Disposition/AskFamily/AskState) stay local. So
// care_call_outcomes.derived is literally clinical-state/1.2 assertions → the write-back loop is a
// near-identity map (single source of truth).

import type {
  MedicationStatus, AllergyStatus, ComplaintStatus, FollowUpAction, StopReason,
  MedicationAssertion, AllergyAssertion, ComplaintStatusAssertion, FollowUpAssertion, Provenance,
} from './clinical-state/schema';
import type { DeidOpdCase } from './opd-ingest-core';

export const CARE_CALL_ENGINE = 'care-call/0.1' as const;
export const ASK_SET_VERSION = 'ask-set/0.1' as const;

// Care-Call-only enums (stay local):
export type Disposition = 'connected' | 'no_answer' | 'wrong_number' | 'refused' | 'call_later';
export type AskFamily = 'MED_STATUS' | 'FOLLOWUP_ACTION' | 'COMPLAINT_STATUS' | 'ALLERGY_CONFIRM' | 'OUTSIDE_RECORDS';
export type AskState = 'answered' | 'skipped' | 'not_generated';   // skipped = CM chose not to ask; ≠ 'unknown'

const DISPOSITIONS: ReadonlySet<string> = new Set<Disposition>(['connected', 'no_answer', 'wrong_number', 'refused', 'call_later']);
// legal answer enums per family (the client sends the canonical value, not the display chip label):
const MED_ANSWERS: ReadonlySet<string> = new Set<MedicationStatus>(['reported_taking', 'not_taking', 'stopped', 'unknown']);
const FOLLOWUP_ANSWERS: ReadonlySet<string> = new Set<FollowUpAction>(['committed', 'already_done_inhouse', 'already_done_outside', 'declined', 'undecided']);
const COMPLAINT_ANSWERS: ReadonlySet<string> = new Set<ComplaintStatus>(['resolved', 'improving', 'unchanged', 'worse']);
const ALLERGY_ANSWERS: ReadonlySet<string> = new Set<AllergyStatus>(['denied', 'reported_allergy']);
const OUTSIDE_ANSWERS: ReadonlySet<string> = new Set(['will_send', 'doesnt_have', 'declined']);
const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>(['side_effect', 'cost', 'felt_better', 'ran_out', 'other']);

export interface AskItem {
  id: string;            // deterministic `${family}:${slug(subject)}` — stable across re-renders
  family: AskFamily;
  subject: string;       // med "generic (brand strength)" · follow-up line · complaint text · '' for D/E
  question: string;      // rendered text (mockup copy is normative)
  meta?: { highAlert?: boolean; dose?: string; frequency?: string };
}
export interface OverflowItem { family: AskFamily; subject: string }
export interface AskKeys { presc_uid: string; individual_uid: string; uhid?: string | null; note_date?: string | null }

export interface AskResponse { askId: string; family: AskFamily; subject: string; state: AskState; answer?: string; reason?: string; targetDate?: string | null; freeText?: string; highAlert?: boolean }
export interface DerivedAssertions { medications: MedicationAssertion[]; allergies: AllergyAssertion[]; complaints: ComplaintStatusAssertion[]; followUps: FollowUpAssertion[] }
export interface CareCallOutcome {
  id: string; presc_uid: string; individual_uid: string; uhid?: string | null; note_date?: string | null;
  attempt: number; called_at: string; disposition: Disposition;
  engine_version: string; ask_set_version: string;
  responses: AskResponse[];
  derived: DerivedAssertions;
  flags: { escalation: null | { reason: 'symptom_worse' | 'high_alert_med_stopped'; askId: string } };
  cm_ref?: string | null;
}

const slug = (s: string): string => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n).trim() : s).trim();
/** med display label — "Metformin (Glycomet 500)" style (mockup). deriveAssertions parses it back. */
function medLabel(m: DeidOpdCase['medications'][number]): string {
  const g = (m.generic || '').trim(); const b = (m.brand || '').trim(); const s = (m.strength || '').trim();
  const brandPart = b ? ` (${b}${s ? ` ${s}` : ''})` : (s ? ` (${s})` : '');
  return `${g || b || 'medication'}${g ? brandPart : ''}`.trim();
}
/** parse a med label back into { raw, generic, brand } for the derived MedicationConcept. */
function parseMed(subject: string): { raw: string; generic?: string; brand?: string } {
  const m = subject.match(/^\s*(.+?)\s*\((.+)\)\s*$/);
  return m ? { raw: subject, generic: m[1].trim(), brand: m[2].trim() } : { raw: subject, generic: subject.trim() };
}

// ── FOLLOWUP subject extraction (deterministic, §3.2) ──
const FOLLOWUP_RE = /\b(repeat|review|follow[\s-]?up|after\s+\d+\s+(day|week|month))/i;
export function followUpSubjects(oc: DeidOpdCase): string[] {
  const hay = [...(oc.advice || []), ...(oc.investigations || [])];
  const hits = hay.filter((l) => typeof l === 'string' && FOLLOWUP_RE.test(l)).map((l) => clip(l.trim()));
  if (hits.length) return [hits[0]];
  const ft = oc.followUpType;
  if (ft && !/^(unknown|none)$/i.test(ft) && oc.followUpDateSet === false) return [clip(`Follow-up: ${ft}`)];
  return [];
}

// ── Ask generator (pure, §3) ──
export function buildAskSet(oc: DeidOpdCase, keys: AskKeys): { asks: AskItem[]; overflow: OverflowItem[] } {
  void keys;
  const mk = (family: AskFamily, subject: string, question: string, meta?: AskItem['meta']): AskItem => ({ id: `${family}:${slug(subject)}`, family, subject, question, meta });

  // MED_STATUS — high-alert first, then a therapeuticClass present, then note order; max 3 med asks.
  const meds = (oc.medications || []).slice();
  const rank = (m: typeof meds[number]) => (m.highAlert ? 0 : m.therapeuticClass ? 1 : 2);
  const medsSorted = meds.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  const medAskAll = medsSorted.map((m, idx) => {
    const label = medLabel(m);
    const dose = [m.dose, m.frequency].filter(Boolean).join(', ');
    const q = idx === 0
      ? `Doctor prescribed ${label}${dose ? `, ${dose}` : ''} — are you taking it?`
      : `And ${label}${dose ? `, ${dose}` : ''} — taking it?`;
    return mk('MED_STATUS', label, q, { highAlert: !!m.highAlert, dose: m.dose, frequency: m.frequency });
  });
  const medAsks = medAskAll.slice(0, 3);
  const medOverflow = medsSorted.slice(3).map((m) => ({ family: 'MED_STATUS' as const, subject: medLabel(m) }));
  const highAlertAsks = medAsks.filter((a) => a.meta?.highAlert);
  const otherMedAsks = medAsks.filter((a) => !a.meta?.highAlert);

  // FOLLOWUP_ACTION — max 1.
  const fu = followUpSubjects(oc);
  const followUpAsks = fu.map((s) => mk('FOLLOWUP_ACTION', s, `Doctor advised ${clip(s)} — shall I help you book it now?`));

  // COMPLAINT_STATUS — note order, max 2.
  const complaintAsks = (oc.presentingComplaints || []).slice(0, 2).map((c) => mk('COMPLAINT_STATUS', clip(c), `You came in for ${clip(c)} — how is it now?`));

  // ALLERGY_CONFIRM — only when the note's allergy field is blank.
  const allergyBlank = !oc.allergies || !String(oc.allergies).trim();
  const allergyAsks = allergyBlank ? [mk('ALLERGY_CONFIRM', '', 'Before I go — any medicine allergies we should have on file?')] : [];

  // OUTSIDE_RECORDS — always last if room.
  const outsideAsk = mk('OUTSIDE_RECORDS', '', 'Do you have that report? You can WhatsApp a photo to us right now.');

  // Assembly order (§3.3): high-alert meds → follow-up → other meds → complaints → allergy → outside. Cap 5.
  const ordered = [...highAlertAsks, ...followUpAsks, ...otherMedAsks, ...complaintAsks, ...allergyAsks, outsideAsk];
  const asks = ordered.slice(0, 5);
  const overflow: OverflowItem[] = [...medOverflow, ...ordered.slice(5).map((a) => ({ family: a.family, subject: a.subject }))];
  return { asks, overflow };
}

// ── Chip → assertion derivation (pure, §4.3; enums identical to 1.2, so the mapping is unchanged) ──
function prov(rawText: string): Provenance {
  return { sourceField: 'care_call_outcomes', rawText, extractionMethod: 'reported', confidence: 0.9, reporter: 'patient_via_care_manager', trust: 'patient_reported' };
}
const aid = (family: string, subject: string, tag: string): string => `cc-${family.toLowerCase()}-${slug(subject)}-${tag}`;

export function deriveAssertions(responses: AskResponse[]): DerivedAssertions {
  const medications: MedicationAssertion[] = [];
  const allergies: AllergyAssertion[] = [];
  const complaints: ComplaintStatusAssertion[] = [];
  const followUps: FollowUpAssertion[] = [];
  for (const r of responses || []) {
    if (r.state !== 'answered' || !r.answer) continue;   // skip / not_generated → NO assertion
    const a = String(r.answer);
    if (r.family === 'MED_STATUS' && MED_ANSWERS.has(a)) {
      const c = parseMed(r.subject);
      const stopReason = a === 'stopped' && r.reason && STOP_REASONS.has(r.reason) ? (r.reason as StopReason) : null;
      medications.push({ id: aid('med', r.subject, a), medicationConcept: { raw: c.raw, generic: c.generic, brand: c.brand, normalizedConceptId: null }, status: a as MedicationStatus, stopReason, provenance: prov(a), encounterRef: null });
    } else if (r.family === 'FOLLOWUP_ACTION' && FOLLOWUP_ANSWERS.has(a)) {
      followUps.push({ id: aid('fu', r.subject, a), subject: r.subject, action: a as FollowUpAction, targetDate: a === 'committed' ? (r.targetDate ?? null) : null, provenance: prov(a), encounterRef: null });
    } else if (r.family === 'COMPLAINT_STATUS' && COMPLAINT_ANSWERS.has(a)) {
      complaints.push({ id: aid('cmp', r.subject, a), concept: { raw: r.subject, normalizedConceptId: null }, status: a as ComplaintStatus, provenance: prov(a), encounterRef: null });
    } else if (r.family === 'ALLERGY_CONFIRM' && ALLERGY_ANSWERS.has(a)) {
      const isDenied = a === 'denied';
      allergies.push({ id: aid('alg', isDenied ? 'nka' : (r.freeText || 'unspecified'), a), substance: { raw: isDenied ? 'no known allergy' : (r.freeText?.trim() || 'unspecified'), normalized: isDenied ? 'no known allergy' : null }, status: a as AllergyStatus, reaction: null, provenance: prov(r.freeText?.trim() || a), encounterRef: null });
    }
    // OUTSIDE_RECORDS → no assertion (stub, §Decision 4)
  }
  return { medications, allergies, complaints, followUps };
}

// ── Escalation (pure, §4.5) ──
export function escalationFlag(responses: AskResponse[]): CareCallOutcome['flags']['escalation'] {
  for (const r of responses || []) {
    if (r.state !== 'answered') continue;
    if (r.family === 'COMPLAINT_STATUS' && r.answer === 'worse') return { reason: 'symptom_worse', askId: r.askId };
  }
  for (const r of responses || []) {
    if (r.state !== 'answered') continue;
    if (r.family === 'MED_STATUS' && (r.answer === 'stopped' || r.answer === 'not_taking') && r.highAlert === true) return { reason: 'high_alert_med_stopped', askId: r.askId };
  }
  return null;
}

// ── Outcome validation (§5.2) — known disposition, askIds echo the served set, legal enums ──
const ANSWERS_BY_FAMILY: Record<AskFamily, ReadonlySet<string>> = {
  MED_STATUS: MED_ANSWERS, FOLLOWUP_ACTION: FOLLOWUP_ANSWERS, COMPLAINT_STATUS: COMPLAINT_ANSWERS, ALLERGY_CONFIRM: ALLERGY_ANSWERS, OUTSIDE_RECORDS: OUTSIDE_ANSWERS,
};
export function validateOutcome(o: { disposition?: unknown; responses?: unknown }, servedAskIds: ReadonlySet<string>): { ok: true } | { ok: false; reason: string } {
  if (typeof o.disposition !== 'string' || !DISPOSITIONS.has(o.disposition)) return { ok: false, reason: 'unknown disposition' };
  const responses = Array.isArray(o.responses) ? (o.responses as AskResponse[]) : [];
  for (const r of responses) {
    if (r.state === 'not_generated') continue;   // overflow markers are not served asks
    if (servedAskIds.size && r.askId && !servedAskIds.has(r.askId)) return { ok: false, reason: `foreign askId ${r.askId}` };
    if (r.state === 'answered') {
      const legal = ANSWERS_BY_FAMILY[r.family];
      if (!legal || !r.answer || !legal.has(String(r.answer))) return { ok: false, reason: `illegal answer for ${r.family}` };
      if (r.family === 'MED_STATUS' && r.answer === 'stopped' && r.reason && !STOP_REASONS.has(r.reason)) return { ok: false, reason: 'illegal stop reason' };
    }
  }
  return { ok: true };
}
