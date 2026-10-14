/**
 * lib/ipd-audit/assemble.ts — PURE assembly of an ipd_discharge_audits row from the shipped
 * engine's output (doc-audit extract + analyze + value-score-core). No db, no llm, no fetch.
 *
 * PHI POSTURE (structural): the row is built ONLY from (a) the de-identified AuditReport /
 * ExtractedCase and (b) the db13 admission ENVELOPE keys (document/ip/member ids, speciality,
 * ward-class facts). There is no code path that can place a patient name/UHID on the row —
 * IpdAuditMeta simply has no such field, and lib/__tests__/ipd-audit-surface.test.ts asserts
 * both that and the INSERT column list. Names/UHID are joined from db13 at READ time only.
 */

import type { AuditReport, ExtractedCase } from '../doc-audit-core';
import type { ValueDomain } from '../value-score-core';
import type { IpdAuditRow } from './store';
import { IPD_ENGINE_VERSION } from './store';

/** The db13 admission envelope — link-back keys + non-identifying header facts ONLY. */
export interface IpdAuditMeta {
  documentId: string;
  ipUid?: string | null;
  memberId?: string | null;
  speciality?: string | null;
  dischargeType?: string | null;
  losDays?: number | null;
  dischargedAt?: string | null;   // ISO timestamp
  billedTotal?: number | null;    // S7 — the db13 billing envelope's ₹ scalar; null = no linked bill
  engineVersion?: string;
  model?: string | null;
  traceId?: string | null;
}

function domainScore(report: AuditReport, key: ValueDomain): number | null {
  const d = report.valueScore?.domains.find((x) => x.domain === key);
  return d ? Math.round(d.score) : null;
}

/** Map engine output → one de-identified row. Throws if the report lacks a scorecard. */
export function buildIpdAuditRow(meta: IpdAuditMeta, extracted: ExtractedCase, report: AuditReport): IpdAuditRow {
  const vs = report.valueScore;
  if (!vs) throw new Error('report has no valueScore — cannot persist a headline-less audit');
  const findings = report.findings ?? [];
  return {
    documentId: meta.documentId,
    ipUid: meta.ipUid ?? null,
    memberId: meta.memberId ?? null,
    speciality: meta.speciality ?? null,
    dischargeType: meta.dischargeType ?? null,
    losDays: meta.losDays ?? extracted.adminFacts?.lengthOfStayDays ?? null,
    dischargedAt: meta.dischargedAt ?? null,
    billedTotal: meta.billedTotal ?? null,
    careValueIndex: Math.round(vs.headline),
    band: vs.band,
    scoreAppropriateness: domainScore(report, 'appropriateness'),
    scoreEfficiency: domainScore(report, 'efficiency'),
    scoreSafety: domainScore(report, 'safety'),
    scoreCost: domainScore(report, 'cost'),
    scoreDocumentation: domainScore(report, 'documentation'),
    scorePatientCentred: domainScore(report, 'patient_centred'),
    completenessPct: Math.round((report.completeness?.coverage ?? 0) * 100),
    nFindings: findings.length,
    nLowValue: findings.filter((f) => f.verdict === 'low-value').length,
    nContextDependent: findings.filter((f) => f.verdict === 'context-dependent').length,
    findings,
    suggestions: report.suggestions ?? [],
    report,
    engineVersion: meta.engineVersion || IPD_ENGINE_VERSION,
    model: meta.model ?? null,
    traceId: meta.traceId ?? null,
  };
}
