// lib/member-state/aggregate-core.ts — MemberState Stage 0 reconciliation engine. PURE,
// deterministic, Plane-1 only. buildMemberState(evidence, computedAt) → MemberStateSnapshot.
// Enforces the validation-contract invariants BY CONSTRUCTION:
//   1 no resolution from silence  2 single-member by shape  3 no merge without a dictionary
//   decision  4 total provenance  5 derived status records its occurrences  6 conflicts never
//   discarded (typed Discrepancy)  7 rebuildable (no Date.now/random; computedAt passed in)
//   9 version metadata mandatory  10 `unresolved` flows as data.
// Open-loops (Plane 3) and trend/velocity (Stage 4+) are intentionally absent.

import type {
  MemberEvidence, EncounterEvidence, MemberStateSnapshot, NormalizedConcept,
  LongitudinalProblem, LongitudinalStatus, ProblemCourse, ProblemOccurrence,
  LongitudinalMedication, MedicationOccurrence, LongitudinalAllergy, AllergyOccurrence,
  LongitudinalInvestigation, InvestigationPoint, Discrepancy, EvidenceRef,
} from './schema';
import { MEMBER_STATE_VERSION, NORMALIZATION_VERSION } from './schema';
import type { MedicationStatus, AllergyStatus, FollowUpAssertion } from '../clinical-state/schema';
import { normalizeConcept, normalizeRaw, groupingKey } from './normalize-core';

// member-reconcile/0.3 (Stage-1 ratified pre-freeze fix, R1+R2). Defined here because schema.ts is
// frozen this phase: its RECONCILIATION_VERSION export ('member-reconcile/0.2') is superseded by
// this constant, which the engine now stamps onto the snapshot. (Flagged in the build report.)
export const MEMBER_RECONCILE_VERSION = 'member-reconcile/0.3' as const;

// ── Labelled deterministic constants (heuristics, no clinical judgment) ──
const RECURRENCE_GAP_DAYS = 180;   // a silent gap > this between touches → recurrent
const PERSISTENT_SPAN_DAYS = 365;  // touches spanning > this (no big gap) → persistent

// R1 (V-ratified) — a versioned chronicity dictionary. A chronic concept re-documented across ≥2
// encounters ⇒ 'persistent' regardless of gap length (a yearly-documented chronic is persistent,
// not recurrent). Episodic concepts keep the present-gap-present ⇒ recurrent logic. Clinician-
// reviewed seed list (part of member-reconcile/0.3); grows with the terminology service.
const CHRONIC_CONCEPT_IDS: ReadonlySet<string> = new Set([
  'local:diabetes-mellitus', 'local:type-2-diabetes', 'local:hypertension', 'local:ckd',
  'local:hypothyroidism', 'local:ihd', 'local:asthma',
]);
const CHRONIC_ICD_ROOTS: ReadonlySet<string> = new Set([
  'e10', 'e11',                        // diabetes mellitus
  'i10', 'i11', 'i12', 'i13', 'i15',   // hypertension / hypertensive disease
  'n18',                               // chronic kidney disease
  'e78',                               // dyslipidaemia
  'e03',                               // hypothyroidism
  'j44', 'j45',                        // COPD / asthma
  'g40',                               // epilepsy
  'i20', 'i25',                        // angina / chronic ischaemic heart disease (CAD) — acute MI (i21/i22) excluded
]);
function isChronicConcept(nc: NormalizedConcept): boolean {
  if (nc.normalizedConceptId && CHRONIC_CONCEPT_IDS.has(nc.normalizedConceptId)) return true;
  const root = normalizeRaw(nc.raw).split(' ')[0];   // ICD code root, e.g. 'e11', 'e78' (from 'E78.5')
  return CHRONIC_ICD_ROOTS.has(root);
}

// ── Pure date helpers (deterministic: pure functions of the passed-in ISO strings) ──
function parseDay(iso: string): number { const t = Date.parse(iso); return Number.isNaN(t) ? NaN : Math.floor(t / 86400000); }
function daysBetween(a: string, b: string): number {
  const da = parseDay(a), db = parseDay(b);
  return Number.isNaN(da) || Number.isNaN(db) ? 0 : db - da;
}
function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function byDateRef(a: { date: string; encounterRef: string }, b: { date: string; encounterRef: string }): number {
  return cmpStr(a.date, b.date) || cmpStr(a.encounterRef, b.encounterRef);
}
/** djb2 (the mkFindingId algorithm) — stable ids without Date/random. */
function djb2(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); }

const ON_MED: ReadonlySet<MedicationStatus> = new Set<MedicationStatus>(['prescribed', 'reported_taking', 'administered']);
const OFF_MED: ReadonlySet<MedicationStatus> = new Set<MedicationStatus>(['stopped', 'not_taking']);

export function buildMemberState(evidence: MemberEvidence, computedAt: string): MemberStateSnapshot {
  // Invariant 2 — single member by shape; a blank memberRef is a hard error, never a silent join.
  if (!evidence || typeof evidence.memberRef !== 'string' || evidence.memberRef.trim() === '') {
    throw new Error('buildMemberState: evidence.memberRef is required (single-member invariant)');
  }
  const encounters = Array.isArray(evidence.encounters) ? evidence.encounters : [];
  const asOf = encounters.reduce((mx, e) => (e.date > mx ? e.date : mx), '');
  const conflicts: Discrepancy[] = [];
  const seenConflictIds = new Set<string>();
  const pushConflict = (d: Omit<Discrepancy, 'id'>) => {
    const key = `${d.domain}|${d.type}|${d.assertions.map((a) => `${a.encounterRef}@${a.date}`).sort().join(',')}`;
    const id = `disc-${djb2(key)}`;
    if (seenConflictIds.has(id)) return;
    seenConflictIds.add(id);
    conflicts.push({ id, ...d });
  };

  const problems = buildProblems(encounters, asOf);
  const medications = buildMedications(encounters, pushConflict);
  const allergies = buildAllergies(encounters, pushConflict);
  const investigations = buildInvestigations(encounters, pushConflict);
  detectDemographicConflict(encounters, pushConflict);
  const followUps = buildFollowUps(encounters);   // 1.2 rule 4 — carried, deduped, NO overlay

  const sortedConflicts = conflicts.slice().sort((a, b) => cmpStr(a.domain, b.domain) || cmpStr(a.type, b.type) || cmpStr(a.id, b.id));
  const sourceEncounterRefs = encounters.map((e) => e.encounterRef).slice().sort(cmpStr);

  return {
    version: MEMBER_STATE_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    reconciliationVersion: MEMBER_RECONCILE_VERSION,
    computedAt,
    asOf,
    sourceWatermarks: { ...(evidence.sourceWatermarks || {}) },
    problems,
    medications,
    allergies,
    investigations,
    conflicts: sortedConflicts,
    followUps,
    sourceEncounterRefs,
  };
}

// ── Follow-ups (1.2 rule 4) — carried onto the snapshot, deduped by id, deterministically
//    ordered by (targetDate, id). NO care-coordination/open-loop overlay (Plane 3, later). ──
function buildFollowUps(encounters: EncounterEvidence[]): FollowUpAssertion[] {
  const byId = new Map<string, FollowUpAssertion>();
  for (const e of encounters) for (const f of e.followUps || []) if (f && f.id && !byId.has(f.id)) byId.set(f.id, f);
  return Array.from(byId.values()).sort((a, b) => cmpStr(a.targetDate ?? '', b.targetDate ?? '') || cmpStr(a.id, b.id));
}

// ── Problems (invariants 1, 5) ──────────────────────────────────────────────────
function buildProblems(encounters: EncounterEvidence[], asOf: string): LongitudinalProblem[] {
  const groups = new Map<string, { concept: NormalizedConcept; occ: ProblemOccurrence[] }>();
  for (const e of encounters) {
    for (const p of e.problems || []) {
      const concept = normalizeConcept(p.conceptRaw, 'problem');
      const key = groupingKey(concept);
      const status: LongitudinalStatus = p.explicitStatus === 'resolved' ? 'documented_resolved' : 'documented_active';
      const g = groups.get(key) ?? { concept, occ: [] };
      g.occ.push({ encounterRef: e.encounterRef, date: e.date, status, provenance: p.provenance });
      groups.set(key, g);
    }
    // 1.2 rule 1 — patient-reported complaint status is an EXPLICIT resolution/activity signal.
    // `resolved` → documented_resolved occurrence (the real signal replacing the silence→uncertain
    // guess; invariant 1 intact); improving/unchanged/worse → documented_active. A complaint whose
    // concept matches no documented problem still forms its own group (a patient-reported problem
    // is a real problem — §2.4).
    for (const cs of e.complaintStatuses || []) {
      const concept = normalizeConcept(cs.concept.raw, 'problem');
      const key = groupingKey(concept);
      const status: LongitudinalStatus = cs.status === 'resolved' ? 'documented_resolved' : 'documented_active';
      const g = groups.get(key) ?? { concept, occ: [] };
      g.occ.push({ encounterRef: e.encounterRef, date: e.date, status, provenance: cs.provenance });
      groups.set(key, g);
    }
  }
  const out: LongitudinalProblem[] = [];
  for (const [, g] of groups) {
    const occ = g.occ.slice().sort(byDateRef);
    const first = occ[0], last = occ[occ.length - 1];
    const n = occ.length;

    // Status (invariant 1): explicit resolution ONLY from the latest occurrence; silence (a later
    // encounter that omitted this problem, i.e. lastDocumentedAt < asOf) → uncertain, NEVER resolved.
    let latestDocumentedStatus: LongitudinalStatus;
    if (last.status === 'documented_resolved') latestDocumentedStatus = 'documented_resolved';
    else if (last.date === asOf) latestDocumentedStatus = 'documented_active';
    else latestDocumentedStatus = 'uncertain_current_status';

    const course = deriveCourse(occ.map((o) => o.date), g.concept);
    const daysSince = daysBetween(last.date, asOf);
    const touch = Math.min(1, 0.6 + 0.1 * (n - 1));
    let currentStatusConfidence: number;
    if (latestDocumentedStatus === 'documented_resolved') currentStatusConfidence = 0.9;
    else if (latestDocumentedStatus === 'documented_active') currentStatusConfidence = Math.round(touch * 100) / 100;
    else {
      const recency = daysSince <= 365 ? 0.6 : daysSince <= 730 ? 0.4 : daysSince <= 1095 ? 0.3 : 0.2;
      currentStatusConfidence = Math.round(recency * touch * 100) / 100;
    }

    out.push({
      normalizedConcept: g.concept,
      latestDocumentedStatus,
      latestStatusAt: last.date,
      firstDocumentedAt: first.date,
      lastDocumentedAt: last.date,
      course,
      currentStatusConfidence,
      occurrences: occ,
    });
  }
  return out.sort((a, b) => cmpStr(problemKey(a), problemKey(b)));
}

function problemKey(p: LongitudinalProblem): string {
  return `${p.normalizedConcept.normalizedConceptId ?? p.normalizedConcept.raw.toLowerCase()}|${p.firstDocumentedAt}`;
}

function deriveCourse(datesUnsorted: string[], concept: NormalizedConcept): ProblemCourse {
  const dates = datesUnsorted.slice().sort(cmpStr);
  if (dates.length <= 1) return 'single_episode';
  // R1 — a chronic concept re-documented across ≥2 encounters is persistent regardless of gaps
  // (yearly-documented chronic ≠ recurrent). Episodic concepts fall through to the gap logic.
  if (isChronicConcept(concept)) return 'persistent';
  let maxGap = 0;
  for (let i = 1; i < dates.length; i++) maxGap = Math.max(maxGap, daysBetween(dates[i - 1], dates[i]));
  if (maxGap > RECURRENCE_GAP_DAYS) return 'recurrent';
  if (daysBetween(dates[0], dates[dates.length - 1]) > PERSISTENT_SPAN_DAYS) return 'persistent';
  return 'uncertain';
}

// ── Medications (currentness never inferred to taking) ──────────────────────────
function buildMedications(encounters: EncounterEvidence[], pushConflict: (d: Omit<Discrepancy, 'id'>) => void): LongitudinalMedication[] {
  const groups = new Map<string, { concept: NormalizedConcept; occ: (MedicationOccurrence & { status: MedicationStatus; patientReported: boolean })[] }>();
  for (const e of encounters) {
    for (const m of e.medicationAssertions || []) {
      const raw = m.medicationConcept?.generic || m.medicationConcept?.brand || m.medicationConcept?.raw || '';
      if (!raw) continue;
      const concept = normalizeConcept(raw, 'medication');
      // preserve the source brand when the seed didn't supply one
      if (!concept.brand && m.medicationConcept?.brand) concept.brand = m.medicationConcept.brand;
      const key = groupingKey(concept);
      const g = groups.get(key) ?? { concept, occ: [] };
      g.occ.push({
        encounterRef: e.encounterRef, date: e.date,
        dose: m.dose ?? null, frequency: m.frequency ?? null, route: m.route ?? null, duration: m.duration ?? null,
        stopReason: m.stopReason ?? null,          // 1.2 — carried when a patient-reported 'stopped' has a reason
        provenance: m.provenance, status: m.status, patientReported: m.provenance?.trust === 'patient_reported',
      });
      groups.set(key, g);
    }
  }
  const out: LongitudinalMedication[] = [];
  for (const [, g] of groups) {
    const occ = g.occ.slice().sort(byDateRef);
    const statuses = occ.map((o) => o.status);
    // 1.2 rule 2 — trust-weighted currentness: a patient-reported occurrence's status (the most
    // recent one) overrides the prescription default; ELSE fall back to the existing latest-wins
    // behaviour (neutral when no patient-reported evidence — §2.4, and stays intact per the kickoff).
    // Currentness is never SYNTHESIZED to 'reported_taking' — it only reflects what was asserted.
    const patientOccs = occ.filter((o) => o.patientReported);
    const status = patientOccs.length ? patientOccs[patientOccs.length - 1].status : occ[occ.length - 1].status;
    // R2 (V-ratified) — a patient-reported stop FOLLOWED BY a later fresh prescription: currentness
    // stays 'stopped' (above; a re-script never synthesizes taking) AND the re-prescription surfaces
    // as a temporal_conflict carrying both events + both provenances, for the CM verify-loop to close.
    // This supersedes the generic on/off status_conflict for the same drug (no double-flagging).
    const patientStop = [...occ].reverse().find((o) => o.patientReported && OFF_MED.has(o.status));
    const laterRx = patientStop ? occ.find((o) => o.status === 'prescribed' && o.date > patientStop.date) : undefined;
    if (patientStop && laterRx) {
      pushConflict({
        domain: 'medication', type: 'temporal_conflict', severity: 'review', resolutionStatus: 'open',
        assertions: [
          { encounterRef: patientStop.encounterRef, date: patientStop.date, detail: `${g.concept.raw}: patient-reported ${patientStop.status} [${patientStop.provenance?.trust ?? 'unknown'}]` },
          { encounterRef: laterRx.encounterRef, date: laterRx.date, detail: `${g.concept.raw}: prescribed [${laterRx.provenance?.trust ?? 'unknown'}] — verify` },
        ],
      });
    } else if (statuses.some((s) => ON_MED.has(s)) && statuses.some((s) => OFF_MED.has(s))) {
      // status_conflict: the same drug both on (prescribed/administered/taking) and off (stopped/not_taking).
      pushConflict({
        domain: 'medication', type: 'status_conflict', severity: 'review', resolutionStatus: 'open',
        assertions: occ.map((o): EvidenceRef => ({ encounterRef: o.encounterRef, date: o.date, detail: `${g.concept.raw}: ${o.status}` })),
      });
    }
    out.push({
      normalizedConcept: g.concept,
      status,
      firstSeen: occ[0].date,
      lastSeen: occ[occ.length - 1].date,
      occurrences: occ.map(({ status: _s, patientReported: _pr, ...rest }) => rest),
    });
  }
  return out.sort((a, b) => cmpStr(conceptSortKey(a.normalizedConcept), conceptSortKey(b.normalizedConcept)));
}

// ── Allergies (reported dominates denied; a same-substance clash is safety_critical) ──
function buildAllergies(encounters: EncounterEvidence[], pushConflict: (d: Omit<Discrepancy, 'id'>) => void): LongitudinalAllergy[] {
  const groups = new Map<string, { concept: NormalizedConcept; raw: string; occ: AllergyOccurrence[] }>();
  for (const e of encounters) {
    for (const a of e.allergyAssertions || []) {
      const raw = a.substance?.raw || '';
      if (!raw) continue;
      const concept = normalizeConcept(raw, 'allergy');
      const key = groupingKey(concept);
      const g = groups.get(key) ?? { concept, raw, occ: [] };
      g.occ.push({ encounterRef: e.encounterRef, date: e.date, status: a.status, reaction: a.reaction ?? null, provenance: a.provenance });
      groups.set(key, g);
    }
  }
  const out: LongitudinalAllergy[] = [];
  for (const [, g] of groups) {
    const occ = g.occ.slice().sort(byDateRef);
    const hasReported = occ.some((o) => o.status === 'reported_allergy');
    const hasDenied = occ.some((o) => o.status === 'denied');
    let status: AllergyStatus;
    if (hasReported) status = 'reported_allergy';         // a stated allergy dominates a denial
    else if (hasDenied) status = 'denied';
    else status = occ[occ.length - 1].status;             // e.g. historical / unknown
    // 1.2 rule 3 — a same-substance reported/denied clash stays safety_critical (unconditional, so
    // the invariant-6 behaviour is neutral vs 1.0); each assertion now RECORDS its trust so a
    // patient_reported-denied vs structured_db-reported clash is legible in the Discrepancy.
    if (hasReported && hasDenied) {
      pushConflict({
        domain: 'allergy', type: 'status_conflict', severity: 'safety_critical', resolutionStatus: 'open',
        assertions: occ.map((o): EvidenceRef => ({ encounterRef: o.encounterRef, date: o.date, detail: `${g.raw}: ${o.status} [${o.provenance?.trust ?? 'unknown'}]` })),
      });
    }
    out.push({
      substance: { raw: g.raw, normalized: g.concept.normalizedConceptId ?? null },
      status,
      occurrences: occ,
    });
  }
  return out.sort((a, b) => cmpStr(a.substance.normalized ?? a.substance.raw.toLowerCase(), b.substance.normalized ?? b.substance.raw.toLowerCase()));
}

// ── Investigations (dated numeric series; mixed units surfaced, NEVER auto-converted) ──
function buildInvestigations(encounters: EncounterEvidence[], pushConflict: (d: Omit<Discrepancy, 'id'>) => void): LongitudinalInvestigation[] {
  const groups = new Map<string, { concept: NormalizedConcept; series: InvestigationPoint[] }>();
  for (const e of encounters) {
    for (const iv of e.investigations || []) {
      const concept = normalizeConcept(iv.analyteRaw, 'investigation');
      const key = groupingKey(concept);
      const g = groups.get(key) ?? { concept, series: [] };
      g.series.push({ encounterRef: e.encounterRef, date: e.date, value: iv.value, unit: iv.unit ?? null, abnormal: iv.abnormal ?? null, provenance: iv.provenance });
      groups.set(key, g);
    }
  }
  const out: LongitudinalInvestigation[] = [];
  for (const [, g] of groups) {
    const series = g.series.slice().sort(byDateRef);
    const units = Array.from(new Set(series.map((p) => p.unit).filter((u): u is string => u != null && u !== '')));
    let unit: string | null;
    if (units.length <= 1) unit = units[0] ?? null;
    else {
      unit = null;   // mixed → surface, never auto-convert
      pushConflict({
        domain: 'investigation', type: 'value_conflict', severity: 'review', resolutionStatus: 'open',
        assertions: series.map((p): EvidenceRef => ({ encounterRef: p.encounterRef, date: p.date, detail: `${g.concept.raw}: ${p.value} ${p.unit ?? ''}`.trim() })),
      });
    }
    out.push({ normalizedAnalyte: g.concept, unit, series });
  }
  return out.sort((a, b) => cmpStr(conceptSortKey(a.normalizedAnalyte), conceptSortKey(b.normalizedAnalyte)));
}

// ── Demographic identity conflict (sex flip, or age inconsistent with the timeline) ──
function detectDemographicConflict(encounters: EncounterEvidence[], pushConflict: (d: Omit<Discrepancy, 'id'>) => void): void {
  const withDemo = encounters.filter((e) => e.demographics && (e.demographics.age != null || e.demographics.sex != null));
  const sexes = Array.from(new Set(withDemo.map((e) => e.demographics!.sex).filter((s): s is 'F' | 'M' => s === 'F' || s === 'M')));
  // implied birth year = encounter year − age; a spread > 2 years signals an inconsistent identity (aging is fine).
  const birthYears = withDemo
    .filter((e) => e.demographics!.age != null && /^\d{4}/.test(e.date))
    .map((e) => Number(e.date.slice(0, 4)) - Number(e.demographics!.age));
  const birthSpread = birthYears.length > 1 ? Math.max(...birthYears) - Math.min(...birthYears) : 0;
  if (sexes.length > 1 || birthSpread > 2) {
    pushConflict({
      domain: 'demographic', type: 'identity_conflict', severity: 'review', resolutionStatus: 'open',
      assertions: withDemo.map((e): EvidenceRef => ({ encounterRef: e.encounterRef, date: e.date, detail: `age=${e.demographics!.age ?? '?'} sex=${e.demographics!.sex ?? '?'}` })),
    });
  }
}

function conceptSortKey(c: NormalizedConcept): string { return c.normalizedConceptId ?? `unresolved:${c.raw.toLowerCase()}`; }
