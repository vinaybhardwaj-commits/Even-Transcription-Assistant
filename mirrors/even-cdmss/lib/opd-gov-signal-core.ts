/**
 * lib/opd-gov-signal-core.ts — the governance audit-signal thread CORE (pure).
 *
 * A routed CM triage decision becomes a trackable governance thread (`opd_gov_signal`) with a
 * human reference EHRC-AUD-YYYY-NNNN and an append-only event log. This module owns the pure
 * lifecycle: reference format, SLA, the status machine, the outbound signal-object shape, and the
 * validation for the two write endpoints. All DB work is in lib/opd-gov-signal-store.ts.
 *
 * Contract: CDMSS-OPD-AUDIT-SIGNAL-CONTRACT-v1.0.md (§3 lifecycle, §5 writes, §6 object).
 * Loads under `node --experimental-strip-types` (no runtime imports).
 */

export type SignalStatus = 'routed' | 'responded' | 'escalated' | 'ruled' | 'closed';
export type ResponseType = 'acknowledgment' | 'explanation';
export type ResponseVerdict = 'agree' | 'disagree';
export const SIGNAL_ACTIONS = ['acknowledged_by_governance', 'privilege_action', 'dismissed', 'closed'] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

// ── Reference EHRC-AUD-YYYY-NNNN ──────────────────────────────────────────────
export function formatAuditRef(year: number, n: number): string {
  return `EHRC-AUD-${year}-${String(n).padStart(4, '0')}`;
}
export function parseAuditRef(ref: string): { year: number; n: number } | null {
  const m = /^EHRC-AUD-(\d{4})-(\d{3,})$/.exec((ref || '').trim());
  return m ? { year: Number(m[1]), n: Number(m[2]) } : null;
}
/** A ref is well-formed (for endpoint input guarding). */
export function isAuditRef(ref: string): boolean {
  return parseAuditRef(ref) != null;
}

// ── SLA + mint status ─────────────────────────────────────────────────────────
/** SLA due = created + slaDays, but only when the doctor actually owes a timely response.
 *  `none` (FYI) and `recommend_privilege_review` (no doctor obligation) carry no SLA. */
export function computeSlaDueAt(createdAtIso: string, responseRequired: string, slaDays: number): string | null {
  if (responseRequired === 'none' || responseRequired === 'recommend_privilege_review') return null;
  const d = new Date(createdAtIso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.max(1, slaDays));
  return d.toISOString();
}
/** A privilege-review recommendation escalates immediately (no doctor obligation); else routed. */
export function mintStatus(responseRequired: string): SignalStatus {
  return responseRequired === 'recommend_privilege_review' ? 'escalated' : 'routed';
}
/** Derived overdue flag for a live signal. */
export function isOverdue(s: { status: string; response_required: string; sla_due_at: string | null }, nowIso: string): boolean {
  return s.status === 'routed' && s.response_required !== 'none' && !!s.sla_due_at && nowIso > s.sla_due_at;
}

// ── Status machine ────────────────────────────────────────────────────────────
/** After a doctor response: an explanation the doctor disagrees with returns to CM/gov (escalated);
 *  everything else (acknowledge, or an agreed explanation) is answered. */
export function statusAfterResponse(type: ResponseType, verdict: ResponseVerdict | null): SignalStatus {
  return type === 'explanation' && verdict === 'disagree' ? 'escalated' : 'responded';
}
/** After a governance ruling: dismissed/closed shut the thread; otherwise it is ruled. */
export function statusAfterAction(action: SignalAction): SignalStatus {
  return action === 'dismissed' || action === 'closed' ? 'closed' : 'ruled';
}

// ── Validation: POST /doctor-response (contract §5.1) ─────────────────────────
export interface DoctorResponseInput {
  reference?: string; signal_id?: string; doctor_uid?: string;
  type?: string; verdict?: string; comment?: string;
}
export interface NormalizedDoctorResponse {
  type: ResponseType; verdict: ResponseVerdict | null; comment: string | null;
}
const dstr = (v: unknown, cap = 4000): string | null => (v == null || v === '' ? null : String(v).slice(0, cap));

/** Validate a doctor's answer against the signal's required response. */
export function validateDoctorResponse(
  input: DoctorResponseInput,
  signal: { doctor_uid: string; response_required: string; status: string },
): { ok: true; value: NormalizedDoctorResponse } | { ok: false; error: string; code: 400 | 403 | 409 } {
  if (signal.status === 'closed' || signal.status === 'ruled') {
    return { ok: false, error: 'signal already closed', code: 409 };
  }
  if (input.doctor_uid && input.doctor_uid !== signal.doctor_uid) {
    return { ok: false, error: 'doctor_uid does not match the signal', code: 403 };
  }
  const req = signal.response_required;
  if (req === 'none' || req === 'recommend_privilege_review') {
    return { ok: false, error: `this signal requires no doctor response (${req})`, code: 409 };
  }
  if (input.type !== req) {
    return { ok: false, error: `type must equal the signal's response_required (${req})`, code: 400 };
  }
  if (input.type === 'explanation') {
    const comment = dstr(input.comment);
    if (!comment) return { ok: false, error: 'explanation requires a comment', code: 400 };
    const verdict = input.verdict === 'agree' ? 'agree' : input.verdict === 'disagree' ? 'disagree' : null;
    if (!verdict) return { ok: false, error: 'explanation requires verdict agree|disagree', code: 400 };
    return { ok: true, value: { type: 'explanation', verdict, comment } };
  }
  // acknowledgment
  return { ok: true, value: { type: 'acknowledgment', verdict: null, comment: dstr(input.comment) } };
}

// ── Validation: POST /signal-action (contract §5.2) ───────────────────────────
export interface SignalActionInput {
  reference?: string; signal_id?: string;
  action?: string; note?: string; actor?: string; gov_intervention_ref?: string;
}
export interface NormalizedSignalAction {
  action: SignalAction; note: string | null; actor: string | null; gov_intervention_ref: string | null;
}
export function validateSignalAction(input: SignalActionInput): { ok: true; value: NormalizedSignalAction } | { ok: false; error: string } {
  if (!input.action || !(SIGNAL_ACTIONS as readonly string[]).includes(input.action)) {
    return { ok: false, error: `action must be one of ${SIGNAL_ACTIONS.join('|')}` };
  }
  return {
    ok: true,
    value: {
      action: input.action as SignalAction,
      note: dstr(input.note, 2000), actor: dstr(input.actor, 64),
      gov_intervention_ref: dstr(input.gov_intervention_ref, 128),
    },
  };
}

// ── Outbound signal object (contract §6) ──────────────────────────────────────
export interface SignalRow {
  reference: string; signal_id: string; doctor_uid: string; signal_type: string;
  importance: string; response_required: string; status: string;
  instances?: number | null;
  window_from: string | null; window_to: string | null;
  routed_at: string | null; sla_due_at: string | null;
  latest_response: unknown; ruling: unknown;
}
export interface SignalRepresentative {
  audit_id: string; finding_ref: string; subject: string; verdict: string;
  rationale: string; note_date: string; citations: { n: number; title: string; url: string }[];
}
const LABELS: Record<string, string> = {
  drug_interaction: 'Drug interaction', incomplete_dosing: 'Incomplete dosing',
  duplicate_prescription: 'Duplicate prescription', unverified_brand: 'Unverified brand',
  lasa_pair: 'LASA pair co-prescribed', dose_ceiling_exceeded: 'Daily dose exceeds ceiling',
  dose_ceiling_sos: 'Dose may exceed ceiling if all SOS taken', duplicate_molecule: 'Same molecule in multiple products',
  high_alert_medication: 'High-alert medication', schedule_x: 'Schedule X drug', off_formulary: 'Off-formulary items',
  antibiotic_stewardship: 'Antibiotic stewardship',
  appropriateness_low_value: 'Low-value / inappropriate care', appropriateness_review: 'Appropriateness — needs review',
  appropriateness_high_value: 'High-value care', prescribing_low_value: 'Low-value / unsafe prescribing',
  prescribing_review: 'Prescribing — needs review', prescribing_high_value: 'Sound prescribing',
  appropriateness_general: 'Appropriateness', prescribing_general: 'Prescribing safety',
};
export function signalLabel(signalType: string): string {
  return LABELS[signalType] || signalType.replace(/_/g, ' ');
}

/** Shape one stored thread into the contract §6 object (no PHI; de-identified finding text only). */
export function signalObject(row: SignalRow, representative: SignalRepresentative | null, nowIso: string) {
  return {
    reference: row.reference,
    signal_id: row.signal_id,
    doctor_uid: row.doctor_uid,
    signal_type: row.signal_type,
    label: signalLabel(row.signal_type),
    importance: row.importance,
    response_required: row.response_required,
    status: row.status,
    overdue: isOverdue({ status: row.status, response_required: row.response_required, sla_due_at: row.sla_due_at }, nowIso),
    instances: row.instances ?? (representative ? 1 : 0),
    window: { from: row.window_from, to: row.window_to },
    representative,
    routed_at: row.routed_at,
    sla_due_at: row.sla_due_at,
    response: row.latest_response ?? null,
    ruling: row.ruling ?? null,
  };
}
