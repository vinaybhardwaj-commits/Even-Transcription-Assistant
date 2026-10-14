/**
 * lib/readmission/surface-row.ts — the ONE mapping from a stored `readmission_findings`
 * row (store.SurfaceRow) to what the surface renders (SurfaceFinding). Moved out of the
 * list route in R1 (CDMSS-READMISSIONS-R1-PRD v1.1) so the list route and the new case
 * route map a row IDENTICALLY — the card and the brief can never disagree about a field.
 *
 * Pure: no DB, no model, no React. The KX identity and the index-extract summary are
 * passed IN by the route that joined them; this file only shapes.
 */
import type { SurfaceRow } from './store';
import type { FindingBlob, IndexCaseSummary, ReturnBill, ReturnContext, SurfaceFinding } from '../readmission-surface-core';
import { toFindingClass } from '../readmission-surface-core';
import type { ExtractedCase } from '../doc-audit-core';
import type { CaseArtefacts } from '../readmission-narrative-core';
import { returnContext } from '../readmission-rates-core';

/** Display-only identity from KX (decision 5 / decision 13). Never sent to a model. */
export interface Identity {
  name: string | null; uhid: string | null; ageGender: string | null;
  /** R6: the hospital (db13 facility_name, verbatim) from the ADT name join; null when the join found nothing. */
  facility?: string | null;
}

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** jsonb tolerance: the Neon driver normally hands back a parsed object, but a
 *  TEXT-typed round trip returns the string. Anything else → null, never a throw. */
export function asJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as T;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return null; } }
  return null;
}

/** The index document id, narrowed off the open-record provenance. Null when absent. */
export function indexDocumentIdOf(blob: FindingBlob | null): string | null {
  const v = blob?.labSourceProvenance?.indexDocumentId;
  return typeof v === 'string' && v !== '' ? v : null;
}
export function readmitDocumentIdOf(blob: FindingBlob | null): string | null {
  const v = blob?.labSourceProvenance?.readmitDocumentId;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** §6: the bounded subset of an ExtractedCase the CARD carries. Every field nullable;
 *  a partial or odd extract shape yields nulls, never a throw. */
export function toIndexCaseSummary(e: ExtractedCase | null | undefined): IndexCaseSummary | null {
  if (!e || typeof e !== 'object') return null;
  const age = typeof e.patient?.age === 'number' && Number.isFinite(e.patient.age) ? e.patient.age : null;
  return {
    diagnosis: s(e.diagnosis),
    indication: s(e.indication),
    procedure: s(e.procedure),
    age,
    sex: s(e.patient?.sex),
  };
}

/** `returnBill` (R3-5): the value object the route computed from `r.readmit_encounter_id` —
 *  the id itself is NOT on SurfaceFinding and stays off the client. Null = the caller did not
 *  look (renders exactly like state 'unknown'). */
/**
 * R7 (R7-5 / R7-6) — the return context, PURE, from what the route already joined: the index stay's
 * extracted procedure / followUp / aftercare follow_up_detail on one side; the return stay's extracted
 * procedure + the readmit-side OT-note ledger items (surgery names ride their text) on the other.
 * No extract on either side → staged unmatched (never guessed); immediate is the gap alone.
 */
export function returnContextOf(r: SurfaceRow, blob: FindingBlob | null, indexExtracted: ExtractedCase | null | undefined, readmitExtracted: ExtractedCase | null | undefined): ReturnContext {
  const art = (blob ?? {}) as CaseArtefacts;
  const otReadmit = (art.evidenceLedger?.items ?? []).filter((i) => i.source === 'ot_note' && i.side === 'readmit').map((i) => i.text);
  return returnContext({
    gapDays: r.gap_days == null ? null : Number(r.gap_days),
    indexTexts: [indexExtracted?.procedure, indexExtracted?.followUp, indexExtracted?.aftercare?.follow_up_detail],
    returnTexts: [readmitExtracted?.procedure, ...otReadmit],
  });
}

export function toFinding(r: SurfaceRow, id: Identity | undefined, indexCase: IndexCaseSummary | null = null, returnBill: ReturnBill | null = null, returnCtx: ReturnContext | null = null): SurfaceFinding {
  const blob = asJson<FindingBlob>(r.finding);
  return {
    dedupKey: String(r.dedup_key),
    findingClass: toFindingClass(r.finding_class),   // A3: narrowed at the boundary, never String()
    lane: String(r.lane),
    auditStatus: String(r.audit_status),
    // Name from KX at render; the UHID on the finding row is the authoritative
    // secondary identifier and wins over the joined one (it is what the agent keyed on).
    patientName: id?.name ?? null,
    uhid: s(r.uhid) ?? id?.uhid ?? null,
    ageGender: id?.ageGender ?? null,
    facility: id?.facility ?? null,   // R6 — rides the name join; never stored

    gapDays: r.gap_days == null ? null : Number(r.gap_days),
    indexDepartment: s(r.index_department),
    readmitDepartment: s(r.readmit_department),
    indexDoctor: s(r.index_doctor),
    readmitDoctor: s(r.readmit_doctor),
    indexDischargeAt: s(r.index_discharge_at),
    readmitAdmitAt: s(r.readmit_admit_at),
    payerIndex: s(r.payer_index),
    payerReadmit: s(r.payer_readmit),
    cmNote: s(r.cm_note),
    planned: s(r.planned),
    sameCondition: s(r.same_condition),
    avoidable: s(r.avoidable),
    labTier: s(r.lab_tier),
    labTimingProfile: s(r.lab_timing_profile),
    nOmissions: r.n_omissions == null ? null : Number(r.n_omissions),
    needsHumanReview: r.needs_human_review == null ? null : Boolean(r.needs_human_review),
    promotedToFull: r.promoted_to_full == null ? null : Boolean(r.promoted_to_full),
    notAuditableReason: s(r.not_auditable_reason),
    finding: blob,
    omissionEvidence: asJson<FindingBlob['omissions']>(r.omission_evidence) ?? blob?.omissions ?? null,
    // R1 — the stored judgements and the index-extract join (both additive).
    preventableInjury: s(r.preventable_injury),
    negligence: s(r.negligence),
    judgementRuleVersion: s(r.judgement_rule_version),
    indexCase,
    // R3 — the return-stay bill value object (fresh per read; never the encounter id).
    returnBill,
    // R7 — the return context (immediate / staged markers), derived by code at read time.
    returnContext: returnCtx,
  };
}
