// lib/member-state/validation/score-core.ts — MemberState Stage 1 scoring core (member-eval/0.1).
// PURE, DETERMINISTIC, MECHANICAL comparator: no DB, no llm, no clinical inference, NO thresholds.
// Given (expected label, built snapshot, evidence) it returns a structural CaseScore; aggregate()
// rolls the per-case scores into the contract Part-C metric table. Gating (hard vs provisional
// floors) is applied by the harness/baseline, never here. scoreCase twice → deep-equal.
//
// The frozen core (schema/normalize/aggregate/assemble) is reused TYPE-ONLY, except the two PURE
// normalizer functions (normalizeConcept/groupingKey) which the comparator calls to match concepts
// on the SAME identity basis the core used (value import of frozen pure fns — never modified).

import type {
  MemberStateSnapshot, MemberEvidence, LongitudinalStatus, ProblemCourse, Discrepancy,
} from '../schema';
import type { MedicationStatus, AllergyStatus } from '../../clinical-state/schema';
import { normalizeConcept, groupingKey, type NormalizeDomain } from '../normalize-core';

export const MEMBER_EVAL_VERSION = 'member-eval/0.1' as const;

// One clinician-ratifiable expectation for a synthetic member. Only the fields a stratum exercises
// are asserted; unset fields are not scored (partial labels are legal).
export interface ExpectedLabel {
  caseId: string;
  stratum: number;
  class: 'invariant' | 'accuracy';
  problems?: { concept: string; count: number; status?: LongitudinalStatus; course?: ProblemCourse }[];
  distinctProblemConcepts?: number;         // false-merge / false-split probe
  medications?: { concept: string; status: MedicationStatus }[];
  allergies?: { substance: string; status: AllergyStatus }[];
  investigations?: { analyte: string; points: number; unitMixed?: boolean }[];
  conflicts?: { domain: Discrepancy['domain']; type: Discrepancy['type']; severity: Discrepancy['severity'] }[];
  followUpsCount?: number;                   // 1.2 strata 18/20 — carried/deduped count (additive to §2.1 sketch)
  tbd?: string;                              // stratum 19 — the open question; captured + flagged, never gated
  ratified: boolean;
}

export interface CaseScore {
  caseId: string; stratum: number; class: 'invariant' | 'accuracy';
  sourceEventRetention: number;
  provenanceRetention: number;
  trustProvenanceRetention: number;
  falseMerges: number;
  falseSplits: number;
  incorrectResolutions: number;
  problemStatusAgree: [ok: number, total: number];
  problemCourseAgree: [ok: number, total: number];
  medCurrentnessAgree: [ok: number, total: number];
  conflictRecall: [surfaced: number, seeded: number];
  invariantViolations: string[];   // non-empty ⇒ shippable-blocking (invariant class)
}

const key = (raw: string, domain: NormalizeDomain): string => groupingKey(normalizeConcept(raw, domain));
const ratio = (ok: number, total: number): number => (total ? ok / total : 1);
const hasTrust = (p?: { reporter?: string; trust?: string } | null): boolean => !!(p && (p.reporter || p.trust));

export function scoreCase(expected: ExpectedLabel, built: MemberStateSnapshot, evidence: MemberEvidence): CaseScore {
  const violations: string[] = [];
  const encounters = evidence.encounters || [];

  // ── Retention (source events = problems + complaints + meds + allergies + investigations, each →
  //    exactly one occurrence/point; followUps are a deduped CARRY, not a source-event occurrence). ──
  let inputEvents = 0, inputTrust = 0;
  for (const e of encounters) {
    const items = [
      ...(e.problems || []).map((x) => x.provenance),
      ...(e.complaintStatuses || []).map((x) => x.provenance),
      ...(e.medicationAssertions || []).map((x) => x.provenance),
      ...(e.allergyAssertions || []).map((x) => x.provenance),
      ...(e.investigations || []).map((x) => x.provenance),
    ];
    inputEvents += items.length;
    inputTrust += items.filter(hasTrust).length;
  }
  const occProvs = [
    ...built.problems.flatMap((p) => p.occurrences.map((o) => o.provenance)),
    ...built.medications.flatMap((m) => m.occurrences.map((o) => o.provenance)),
    ...built.allergies.flatMap((a) => a.occurrences.map((o) => o.provenance)),
    ...built.investigations.flatMap((iv) => iv.series.map((o) => o.provenance)),
  ];
  const snapshotEvents = occProvs.length;
  const sourceEventRetention = ratio(snapshotEvents, inputEvents);
  const provenanceRetention = ratio(occProvs.filter((p) => p && typeof p.sourceField === 'string' && p.sourceField.length > 0).length, snapshotEvents);
  const trustProvenanceRetention = ratio(occProvs.filter(hasTrust).length, inputTrust);

  // ── Incorrect resolutions (invariant 1): a documented_resolved occurrence with no explicit
  //    resolved/absent signal (problem.explicitStatus='resolved' or complaint status='resolved'). ──
  const explicitResolved = new Set<string>();
  for (const e of encounters) {
    for (const p of e.problems || []) if (p.explicitStatus === 'resolved') explicitResolved.add(`${e.encounterRef}::${key(p.conceptRaw, 'problem')}`);
    for (const cs of e.complaintStatuses || []) if (cs.status === 'resolved') explicitResolved.add(`${e.encounterRef}::${key(cs.concept.raw, 'problem')}`);
  }
  let incorrectResolutions = 0;
  for (const p of built.problems) {
    const k = groupingKey(p.normalizedConcept);
    for (const o of p.occurrences) if (o.status === 'documented_resolved' && !explicitResolved.has(`${o.encounterRef}::${k}`)) incorrectResolutions++;
  }

  // ── False-merge / false-split from the distinct-concept probe. ──
  let falseMerges = 0, falseSplits = 0;
  if (expected.distinctProblemConcepts != null) {
    const builtDistinct = built.problems.length;
    falseMerges = Math.max(0, expected.distinctProblemConcepts - builtDistinct);
    falseSplits = Math.max(0, builtDistinct - expected.distinctProblemConcepts);
  }

  // ── Agreement tuples (computed for BOTH classes; invariant mismatches also raise violations). ──
  // problem STATUS + COURSE + med CURRENTNESS are ACCURACY metrics (contract §1.C) — scored into the
  // agree tuples, NEVER a gate-blocking violation (a disagreement is a ratification worklist line).
  // Problem COUNT is the merge/split structural probe and IS gated for invariant cases.
  let psOk = 0, psTot = 0, pcOk = 0, pcTot = 0;
  for (const ep of expected.problems || []) {
    const bp = built.problems.find((p) => groupingKey(p.normalizedConcept) === key(ep.concept, 'problem'));
    if (ep.status != null) { psTot++; if (bp && bp.latestDocumentedStatus === ep.status) psOk++; }
    if (ep.course != null) { pcTot++; if (bp && bp.course === ep.course) pcOk++; }
    if (ep.count != null) {
      const matches = built.problems.filter((p) => groupingKey(p.normalizedConcept) === key(ep.concept, 'problem')).length;
      if (matches !== ep.count && expected.class === 'invariant') violations.push(`problem ${ep.concept} count ${matches} ≠ ${ep.count}`);
    }
  }

  let mcOk = 0, mcTot = 0;
  for (const em of expected.medications || []) {
    mcTot++;
    const bm = built.medications.find((m) => groupingKey(m.normalizedConcept) === key(em.concept, 'medication'));
    if (bm && bm.status === em.status) mcOk++;   // currentness = accuracy, scored not gated
  }

  for (const ea of expected.allergies || []) {
    const ba = built.allergies.find((a) => key(a.substance.raw, 'allergy') === key(ea.substance, 'allergy'));
    if ((!ba || ba.status !== ea.status) && expected.class === 'invariant') violations.push(`allergy ${ea.substance} status ${ba?.status ?? 'MISSING'} ≠ ${ea.status}`);
  }

  for (const ei of expected.investigations || []) {
    const bi = built.investigations.find((iv) => groupingKey(iv.normalizedAnalyte) === key(ei.analyte, 'investigation'));
    if (!bi) { if (expected.class === 'invariant') violations.push(`investigation ${ei.analyte} MISSING`); continue; }
    if (bi.series.length !== ei.points && expected.class === 'invariant') violations.push(`investigation ${ei.analyte} points ${bi.series.length} ≠ ${ei.points}`);
    if (ei.unitMixed != null) { const mixed = bi.unit == null; if (mixed !== ei.unitMixed && expected.class === 'invariant') violations.push(`investigation ${ei.analyte} unitMixed ${mixed} ≠ ${ei.unitMixed}`); }
  }

  // ── Conflict recall (seeded conflicts surfaced as a matching typed Discrepancy). ──
  let surfaced = 0;
  const seeded = (expected.conflicts || []).length;
  for (const ec of expected.conflicts || []) {
    const hit = built.conflicts.some((c) => c.domain === ec.domain && c.type === ec.type && c.severity === ec.severity);
    if (hit) surfaced++; else if (expected.class === 'invariant') violations.push(`conflict ${ec.domain}/${ec.type}/${ec.severity} NOT surfaced`);
  }

  // ── Follow-ups carried + deduped (strata 18/20). ──
  if (expected.followUpsCount != null && built.followUps.length !== expected.followUpsCount && expected.class === 'invariant') {
    violations.push(`followUps count ${built.followUps.length} ≠ ${expected.followUpsCount}`);
  }

  // ── Invariant-class hard checks on the mechanical metrics. ──
  if (expected.class === 'invariant') {
    if (sourceEventRetention < 1) violations.push(`source-event retention ${sourceEventRetention.toFixed(3)} < 1.0`);
    if (provenanceRetention < 1) violations.push(`provenance retention ${provenanceRetention.toFixed(3)} < 1.0`);
    if (trustProvenanceRetention < 1) violations.push(`trust-provenance retention ${trustProvenanceRetention.toFixed(3)} < 1.0`);
    if (incorrectResolutions > 0) violations.push(`${incorrectResolutions} incorrect resolution(s)`);
    if (falseMerges > 0) violations.push(`${falseMerges} false merge(s)`);
  }

  return {
    caseId: expected.caseId, stratum: expected.stratum, class: expected.class,
    sourceEventRetention, provenanceRetention, trustProvenanceRetention,
    falseMerges, falseSplits, incorrectResolutions,
    problemStatusAgree: [psOk, psTot], problemCourseAgree: [pcOk, pcTot],
    medCurrentnessAgree: [mcOk, mcTot], conflictRecall: [surfaced, seeded],
    invariantViolations: violations,
  };
}

export interface PartCMetrics {
  cases: number;
  sourceEventRetention: number;      // min over cases (hard = 1.0)
  provenanceRetention: number;
  trustProvenanceRetention: number;
  falseMerges: number;               // total (proposed gate 0)
  falseSplits: number;               // reported, tolerated
  incorrectResolutions: number;      // hard = 0
  invariantViolations: number;       // hard = 0
  problemStatusAccuracy: number | null;  // provisional floor at ratification
  problemCourseAccuracy: number | null;
  medCurrentnessAccuracy: number | null;
  conflictRecall: number | null;         // proposed gate 1.0
}

export function aggregate(scores: CaseScore[]): PartCMetrics {
  const min = (f: (s: CaseScore) => number) => scores.reduce((m, s) => Math.min(m, f(s)), 1);
  const sumT = (f: (s: CaseScore) => [number, number]) => scores.reduce((a, s) => [a[0] + f(s)[0], a[1] + f(s)[1]] as [number, number], [0, 0] as [number, number]);
  const acc = (t: [number, number]): number | null => (t[1] ? t[0] / t[1] : null);
  return {
    cases: scores.length,
    sourceEventRetention: scores.length ? min((s) => s.sourceEventRetention) : 1,
    provenanceRetention: scores.length ? min((s) => s.provenanceRetention) : 1,
    trustProvenanceRetention: scores.length ? min((s) => s.trustProvenanceRetention) : 1,
    falseMerges: scores.reduce((a, s) => a + s.falseMerges, 0),
    falseSplits: scores.reduce((a, s) => a + s.falseSplits, 0),
    incorrectResolutions: scores.reduce((a, s) => a + s.incorrectResolutions, 0),
    invariantViolations: scores.reduce((a, s) => a + s.invariantViolations.length, 0),
    problemStatusAccuracy: acc(sumT((s) => s.problemStatusAgree)),
    problemCourseAccuracy: acc(sumT((s) => s.problemCourseAgree)),
    medCurrentnessAccuracy: acc(sumT((s) => s.medCurrentnessAgree)),
    conflictRecall: acc(sumT((s) => s.conflictRecall)),
  };
}
