// lib/clinical-state/to-audit-family.ts — bidirectional adapters between ClinicalState
// and the DOCUMENT-AUDIT FAMILY's existing shapes: the OPD note-audit findings row
// (opd_note_audits.findings jsonb) and Case Audit's ExtractedCase/AuditFinding
// (lib/doc-audit-core.ts). Pure, unit-tested, and — 1a contract — imported by NO live
// engine. The two engines' verdict/domain vocabularies are preserved VERBATIM in the
// audit extension (note-audit → ext.verdict, doc-audit → ext.netValue); they are never
// collapsed into one vocabulary. Unmapped row fields ride in ext.extra so a real row
// round-trips losslessly (both engines carry fields — rationale, evidence, confidence —
// the §3 row contract doesn't list).

import {
  type ClinicalState, type ClinicalFinding, type AuditExtension,
  emptyClinicalState, mkFindingId, CLINICAL_STATE_VERSION,
} from './schema';
import type { ExtractedCase, AuditFinding, DocType } from '../doc-audit-core';

// ── OPD note-audit findings row (opd_note_audits.findings jsonb) ──

/** The stored row shape (governance spec v2.0 §2). Real rows may carry more keys
 *  (confidence, rationale, evidence, estimates, rule_ref, lvc_category, …) — preserved. */
export interface NoteAuditFindingRow {
  subject: string;
  verdict: string;
  domain: string;
  source?: string;
  informational?: boolean;
  signal_type?: string;
  finding_ref?: string;
  citation_ids?: number[];
  [k: string]: unknown;
}

const NOTE_ROW_TYPED_KEYS = new Set(['subject', 'verdict', 'domain', 'source', 'informational', 'signal_type', 'finding_ref', 'citation_ids']);

export function noteAuditFindingToFinding(row: NoteAuditFindingRow): ClinicalFinding {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!NOTE_ROW_TYPED_KEYS.has(k)) extra[k] = v;
  const ext: AuditExtension = {
    kind: 'audit',
    verdict: row.verdict,
    domain: row.domain,
    ...(row.signal_type !== undefined && { signalType: row.signal_type }),
    ...(row.finding_ref !== undefined && { findingRef: row.finding_ref }),
    ...(row.citation_ids !== undefined && { citationIds: row.citation_ids }),
    ...(row.source !== undefined && { source: row.source }),
    ...(row.informational !== undefined && { informational: row.informational }),
    ...(Object.keys(extra).length && { extra }),
  };
  const conf = typeof row.confidence === 'number' ? Math.max(0, Math.min(1, row.confidence)) : 1;
  return {
    id: row.finding_ref ? `cf-nar-${row.finding_ref}` : mkFindingId(row.subject, 'opd_note_audits.findings', 'present'),
    concept: row.subject,
    status: 'present',
    provenance: {
      sourceField: 'opd_note_audits.findings',
      rawText: row.subject,
      extractionMethod: row.source === 'deterministic' ? 'deterministic' : 'llm',
      confidence: conf,
    },
    ext,
  };
}

export function findingToNoteAuditFinding(f: ClinicalFinding): NoteAuditFindingRow {
  const ext = (f.ext?.kind === 'audit' ? f.ext : { kind: 'audit' as const });
  return {
    subject: f.concept,
    verdict: ext.verdict ?? '',
    domain: ext.domain ?? '',
    ...(ext.source !== undefined && { source: ext.source }),
    ...(ext.informational !== undefined && { informational: ext.informational }),
    ...(ext.signalType !== undefined && { signal_type: ext.signalType }),
    ...(ext.findingRef !== undefined && { finding_ref: ext.findingRef }),
    ...(ext.citationIds !== undefined && { citation_ids: ext.citationIds }),
    ...(ext.extra ?? {}),
  };
}

// ── Case Audit (doc-audit) AuditFinding ──

const AUDIT_FINDING_TYPED_KEYS = new Set(['subject', 'verdict', 'domain', 'citation_ids']);

export function auditFindingToFinding(af: AuditFinding): ClinicalFinding {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(af)) if (!AUDIT_FINDING_TYPED_KEYS.has(k)) extra[k] = v;
  const ext: AuditExtension = {
    kind: 'audit',
    netValue: af.verdict,                              // doc-audit's verdict IS its NetValue — kept verbatim, separate slot
    ...(af.domain !== undefined && { domain: af.domain }),
    citationIds: af.citation_ids,
    ...(Object.keys(extra).length && { extra }),
  };
  return {
    id: mkFindingId(af.subject, 'doc_audit.findings', 'present'),
    concept: af.subject,
    status: 'present',
    provenance: {
      sourceField: 'doc_audit.findings',
      rawText: af.subject,
      extractionMethod: 'llm',
      confidence: typeof af.confidence === 'number' ? Math.max(0, Math.min(1, af.confidence)) : 1,
    },
    ext,
  };
}

export function findingToAuditFinding(f: ClinicalFinding): AuditFinding {
  const ext = (f.ext?.kind === 'audit' ? f.ext : { kind: 'audit' as const });
  return {
    subject: f.concept,
    verdict: (ext.netValue ?? 'uncertain') as AuditFinding['verdict'],
    ...(ext.domain !== undefined && { domain: ext.domain as AuditFinding['domain'] }),
    citation_ids: ext.citationIds ?? [],
    ...(ext.extra ?? {}),
  } as AuditFinding;
}

// ── Case Audit (doc-audit) ExtractedCase ⇄ ClinicalState ──
// Clinical content maps onto the core (findings/meds/riskFactors/disposition/adminFacts);
// document-metadata + narrative fields the core deliberately doesn't model ride in
// surfaceExtras so the round-trip is lossless.

const EC_EXTRAS_KEYS = [
  'docType', 'detectedDocType', 'confidence', 'indication', 'treatments',
  'courseSummary', 'followUp', 'rawNotes', 'completeness', 'aftercare',
] as const;

export function extractedCaseToState(ec: ExtractedCase): ClinicalState {
  const state = emptyClinicalState('doc_audit');

  const sexRaw = ec.patient.sex ?? null;
  state.demographics = {
    age: ec.patient.age ?? null,
    ageBand: ec.patient.age != null ? `${Math.floor(ec.patient.age / 10) * 10}-${Math.floor(ec.patient.age / 10) * 10 + 9}` : null,
    sex: sexRaw ? (/^f/i.test(sexRaw) ? 'F' : /^m/i.test(sexRaw) ? 'M' : null) : null,
    sexRaw,
  };

  if (ec.diagnosis) {
    state.positives.push({
      id: mkFindingId(ec.diagnosis, 'diagnosis', 'present'),
      concept: ec.diagnosis,
      status: 'present',
      provenance: { sourceField: 'diagnosis', rawText: ec.diagnosis, extractionMethod: 'llm', confidence: ec.confidence },
    });
  }
  state.investigations = ec.investigations.map((s) => ({
    test: s, value: '', unit: null, flag: 'indeterminate' as const, category: 'other' as const, note: null,
  }));
  state.medications = [...ec.medications];
  state.riskFactors = [...(ec.riskFactors ?? [])];
  if (ec.procedure) state.procedures = [ec.procedure];
  state.disposition = ec.disposition;
  if (ec.adminFacts) state.adminFacts = ec.adminFacts;
  state.missingCriticalData = (ec.completeness ?? []).filter((c) => c.status === 'missing').map((c) => c.key);

  const surfaceExtras: Record<string, unknown> = {};
  for (const k of EC_EXTRAS_KEYS) if (ec[k] !== undefined) surfaceExtras[k] = ec[k];
  // riskFactors is core clinical content, but the doc-audit field is OPTIONAL (absent on
  // pre-PX extractions) — mark absence so undefined round-trips as undefined, not [].
  if (ec.riskFactors === undefined) surfaceExtras.riskFactorsAbsent = true;
  state.surfaceExtras = surfaceExtras;
  return state;
}

export function stateToExtractedCase(state: ClinicalState): ExtractedCase {
  const x = state.surfaceExtras ?? {};
  const diagnosisFinding = state.positives.find((f) => f.provenance.sourceField === 'diagnosis');
  return {
    docType: (x.docType as DocType) ?? 'discharge_summary',
    detectedDocType: (x.detectedDocType as DocType) ?? ((x.docType as DocType) ?? 'discharge_summary'),
    confidence: typeof x.confidence === 'number' ? x.confidence : 0,
    patient: {
      ...(state.demographics.age != null && { age: state.demographics.age }),
      ...(state.demographics.sexRaw != null && { sex: state.demographics.sexRaw }),
    },
    diagnosis: diagnosisFinding?.concept ?? null,
    indication: (x.indication as string | null) ?? null,
    procedure: state.procedures?.[0] ?? null,
    investigations: state.investigations.map((f) => f.test),
    treatments: (x.treatments as string[]) ?? [],
    medications: [...state.medications],
    courseSummary: (x.courseSummary as string) ?? '',
    disposition: state.disposition ?? null,
    followUp: (x.followUp as string | null) ?? null,
    rawNotes: (x.rawNotes as string) ?? '',
    ...(x.completeness !== undefined && { completeness: x.completeness as ExtractedCase['completeness'] }),
    ...(state.adminFacts !== undefined && { adminFacts: state.adminFacts }),
    ...(x.riskFactorsAbsent !== true && { riskFactors: [...state.riskFactors] }),
    ...(x.aftercare !== undefined && { aftercare: x.aftercare as ExtractedCase['aftercare'] }),
  };
}

export { CLINICAL_STATE_VERSION };
