/**
 * lib/doctor-facing.ts — the doctor-facing payload contract (pure).
 *
 * Everything a physician's portal may receive is BUILT here from an explicit allowlist. Nothing is
 * produced by deleting keys from an internal object, so a field added to a governance object later
 * cannot reach a doctor until someone lists it here (fail closed).
 *
 * Never listed, on purpose: triage (rationale, policy_version), ruling, importance, confidence,
 * probability, jev, engine, model, policy fields, bug_type, validity, CM notes, engine versions.
 * Those stay on the governance-only routes (roster-audits, audit-signal/{ref}).
 *
 * Contract: round-1 spec, "Shared contract change". Runtime imports: none (type imports only).
 */

import type { SignalRow } from './opd-gov-signal-core';

/** Doctor-facing note class. The internal enum calls the middle one `discharge_summary`. */
export type DoctorNoteClass = 'opd' | 'discharge' | 'ot';

export function doctorNoteClass(value: unknown): DoctorNoteClass | null {
  if (value === 'opd') return 'opd';
  if (value === 'discharge' || value === 'discharge_summary') return 'discharge';
  if (value === 'ot') return 'ot';
  return null;
}

// ── patient context ───────────────────────────────────────────────────────────
/**
 * Each field is nullable and is filled only from data CDMSS already stores:
 *   ip_number — ipd_discharge_audits.ip_uid (discharge only)
 *   uhid      — ot_note_audits.uhid (OT only)
 *   name, age, sex — NOT stored in Neon (migrations 0007/0013: "No patient names/UHID are stored";
 *   0061 keeps only uhid). Always null until a stored source exists. Never fetched in a request path.
 */
export interface PatientContext {
  name: string | null;
  age: number | null;
  sex: string | null;
  ip_number: string | null;
  uhid: string | null;
}

const txt = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export function emptyPatient(): PatientContext {
  return { name: null, age: null, sex: null, ip_number: null, uhid: null };
}

export function patientContext(p?: Partial<Record<keyof PatientContext, unknown>> | null): PatientContext {
  if (!p) return emptyPatient();
  const age = p.age == null || p.age === '' ? null : Number(p.age);
  return {
    name: txt(p.name),
    age: age != null && Number.isFinite(age) && age >= 0 && age < 130 ? Math.round(age) : null,
    sex: txt(p.sex),
    ip_number: txt(p.ip_number),
    uhid: txt(p.uhid),
  };
}

// ── evidence + citations ──────────────────────────────────────────────────────
export const EVIDENCE_MAX_CHARS = 600;

/** The audit's evidence points for one finding, joined and trimmed to <= 600 chars. Null when none. */
export function evidenceExcerpt(evidence: unknown): string | null {
  const parts = (Array.isArray(evidence) ? evidence : typeof evidence === 'string' ? [evidence] : [])
    .map((e) => String(e ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const joined = parts.join(' · ');
  if (joined.length <= EVIDENCE_MAX_CHARS) return joined;
  return `${joined.slice(0, EVIDENCE_MAX_CHARS - 1).trimEnd()}…`;
}

export interface DoctorCitation { title: string; url: string | null }

/** `Source 3` with no link is a placeholder, not a citation a doctor can use: drop it. */
export function doctorCitations(
  citations: readonly { n?: number; title?: string | null; url?: string | null }[] | null | undefined,
): DoctorCitation[] {
  const out: DoctorCitation[] = [];
  const seen = new Set<string>();
  for (const c of citations ?? []) {
    const title = txt(c?.title);
    const url = txt(c?.url);
    if (!title) continue;
    if (!url && /^Source \d+$/.test(title)) continue;
    const key = `${title}\0${url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url });
  }
  return out;
}

/** The slice of a stored corpus Source this module reads. */
export interface CitationSource { n: number; book: string; chapter?: string | null; url?: string | null }

/** Finding citation ids → {title, url|null} using the audit's own stored sources. Unknown ids drop. */
export function resolveCitations(ids: readonly number[] | null | undefined, sources: readonly CitationSource[] | null | undefined): DoctorCitation[] {
  if (!ids?.length || !sources?.length) return [];
  return doctorCitations(ids.map((i) => {
    const s = sources.find((x) => x?.n === i);
    return s ? { n: i, title: s.chapter ? `${s.book} — ${s.chapter}` : s.book, url: s.url ?? null } : { n: i, title: null, url: null };
  }));
}

// ── plain verdict words (PDF + any text surface) ──────────────────────────────
const VERDICT_WORDS: Record<string, string> = {
  'high-value': 'Appropriate',
  'context-dependent': 'Depends on the clinical context',
  'low-value': 'Low value',
  uncertain: 'Uncertain',
};
/** Plain words for a verdict code, or null when the code is not one we have words for. */
export function verdictLabel(verdict: unknown): string | null {
  return VERDICT_WORDS[String(verdict ?? '').toLowerCase()] ?? null;
}
/** Text surfaces (the PDF) always need some word: an unknown code reads as a neutral observation. */
export function verdictPlain(verdict: unknown): string {
  return verdictLabel(verdict) ?? 'Observation';
}

// ── doctor-facing instance ────────────────────────────────────────────────────
export interface InstanceSource {
  audit_id: string;
  subject: string;
  verdict: string;
  rationale: string;
  note_date: string;
  citations: readonly { n?: number; title?: string | null; url?: string | null }[];
  evidence_excerpt?: string | null;
  patient?: Partial<Record<keyof PatientContext, unknown>> | null;
}

export interface DoctorInstance {
  /** Opaque id the portal needs to open the findings PDF. Not for display. */
  audit_id: string;
  routed: boolean;
  note_class: DoctorNoteClass | null;
  note_date: string | null;
  subject: string;
  /** Plain words ("Low value"), never the raw code. Null when the code has no label. */
  verdict: string | null;
  rationale: string;
  evidence_excerpt: string | null;
  citations: DoctorCitation[];
  patient: PatientContext;
}

export function doctorInstance(src: InstanceSource, noteClass: unknown, routed: boolean): DoctorInstance {
  return {
    audit_id: String(src.audit_id),
    routed,
    note_class: doctorNoteClass(noteClass),
    note_date: txt(src.note_date),
    subject: String(src.subject ?? ''),
    verdict: verdictLabel(src.verdict),
    rationale: String(src.rationale ?? ''),
    evidence_excerpt: txt(src.evidence_excerpt),
    citations: doctorCitations(src.citations),
    patient: patientContext(src.patient),
  };
}

// ── doctor-facing signal ──────────────────────────────────────────────────────
export interface DoctorResponse {
  verb: string | null;
  type: string | null;
  verdict: string | null;
  comment: string | null;
  responded_at: string | null;
}

/** The doctor's own answer, allowlisted. client_request_id and any other key never leave. */
export function doctorResponse(raw: unknown): DoctorResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    verb: txt(r.verb), type: txt(r.type), verdict: txt(r.verdict),
    comment: txt(r.comment), responded_at: txt(r.responded_at),
  };
}

export interface DoctorSignal {
  reference: string;
  signal_id: string;
  doctor_uid: string;
  signal_type: string;
  note_class: DoctorNoteClass;
  label: string;
  response_required: string;
  status: string;
  overdue: boolean;
  sla_due_at: string | null;
  routed_at: string | null;
  instances: number;
  window: { from: string | null; to: string | null };
  representative: DoctorInstance | null;
  response: DoctorResponse | null;
}

/** Subset of signalObject() the builder reads. `ruling`, `importance` and anything else is ignored. */
export interface SignalObjectLike {
  reference: string; signal_id: string; doctor_uid: string; signal_type: string;
  note_class: SignalRow['note_class'] | string;
  label: string; response_required: string; status: string; overdue: boolean;
  sla_due_at: string | null; routed_at: string | null; instances: number;
  window: { from: string | null; to: string | null };
  response: unknown;
}

export function doctorSignal(sig: SignalObjectLike, representative: DoctorInstance | null): DoctorSignal {
  return {
    reference: sig.reference,
    signal_id: sig.signal_id,
    doctor_uid: sig.doctor_uid,
    signal_type: sig.signal_type,
    note_class: doctorNoteClass(sig.note_class) ?? 'opd',
    label: sig.label,
    response_required: sig.response_required,
    status: sig.status,
    overdue: sig.overdue === true,
    sla_due_at: sig.sla_due_at ?? null,
    routed_at: sig.routed_at ?? null,
    instances: Number(sig.instances) || 0,
    window: { from: sig.window?.from ?? null, to: sig.window?.to ?? null },
    representative,
    response: doctorResponse(sig.response),
  };
}

// ── doctor-facing audit metrics ───────────────────────────────────────────────
export interface DoctorAuditMetrics {
  notes_audited: number;
  nqi_mean: number | null;
  band_a_pct: number | null;
  documentation_completeness: number | null;
  prescribing_safety: number | null;
  top_gap: string | null;
  as_of: string | null;
}

/** Drops engine_versions and oldest_engine_version (engine internals). */
export function doctorAuditMetrics(m: Partial<DoctorAuditMetrics> & Record<string, unknown>): DoctorAuditMetrics {
  const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    notes_audited: Number(m.notes_audited) || 0,
    nqi_mean: num(m.nqi_mean),
    band_a_pct: num(m.band_a_pct),
    documentation_completeness: num(m.documentation_completeness),
    prescribing_safety: num(m.prescribing_safety),
    top_gap: txt(m.top_gap),
    as_of: txt(m.as_of),
  };
}

export const DOCTOR_ADVISORY =
  'These are documentation and prescribing observations reviewed by the quality team. They are not a performance score.';
