// lib/member-state-adapters/med-rec-view.ts — MemberState admission adapter (#5) SL3.
//
// The READ-TIME medication-reconciliation VIEW. PURE (no I/O): given a member's already-fetched OPD
// prescription + lab rows and the persisted admission EpisodeState, it composes the frozen spine
// from OUTSIDE (assembleEvidenceWithAdmission — SL1, behind the flag) + reconciles (buildMemberState
// — the frozen core, called unchanged), then reads the reconciled medication occurrences and
// classifies each drug at the admission moment:
//   continued · newly_started · stopped · dose_or_frequency_changed · reconciliation_gap
// The GAP is the L2 longitudinal check: an OPD-baseline drug ABSENT at discharge with NO documented
// stop. It is the actionable signal — sorted to the top.
//
// FACTS-ONLY: every row cites a REAL occurrence's provenance on each side it has. A drug with no
// occurrence on one side is a gap / newly_started / stopped — never an invented pairing. A dose
// "change" fires ONLY when BOTH sides carry the field and they differ; a missing (extraction-gap)
// admission dose is never rendered as a change.
//
// MED-REC ONLY (Gate D scope): problem-continuity + allergy-conflict are v1.1 — this view carries
// NO problem/allergy field. And NO PERSISTENCE: the view is recomputed read-time on the admin
// surface, never written to a bench/store (SL4 ratifies the med-rec gold).

import { buildMemberState } from '../member-state/aggregate-core';
import { assembleEvidenceWithAdmission } from './discharge-evidence';
import type { assembleEvidence } from '../member-state/assemble-core';       // type-only: the input shape
import type { EpisodeState } from '../episode-state/schema';
import type { MemberEvidence, MedicationOccurrence } from '../member-state/schema';
import type { MemberEvidenceWithAdmission } from './discharge-evidence';

export type MedRecStatus =
  | 'continued'
  | 'newly_started'
  | 'stopped'
  | 'dose_or_frequency_changed'
  | 'reconciliation_gap';

/** One side of a reconciliation row — a real medication occurrence's link-back + provenance. */
export interface MedRecSide {
  encounterRef: string;               // opaque (OPD prescription uid | the admission ip_uid)
  date: string;
  dose: string | null;
  frequency: string | null;
  sourceField: string;                // provenance — where the fact was read
  extractionMethod: string;
  confidence: number;
}

export interface MedRecRow {
  drug: string;                       // normalizedConcept.raw
  status: MedRecStatus;
  opdBaseline: MedRecSide | null;     // the latest pre-admission OPD occurrence (null ⇒ newly_started)
  admission: MedRecSide | null;       // the admission/discharge occurrence (null ⇒ stopped/gap)
}

/** The admission-list-only fallback item (unlinked member / no OPD baseline): drug + its provenance,
 *  with NO baseline to compare against. */
export interface AdmissionMed { drug: string; occurrence: MedRecSide }

export interface MedRecView {
  mode: 'reconciliation' | 'admission_only';
  linked: boolean;                    // did the member resolve to an OPD individual at all
  admissionRef: string;
  rows: MedRecRow[];                  // reconciliation mode: the classified reconciliation
  admissionMedications: AdmissionMed[]; // admission_only mode: the discharge meds, no baseline
  counts: Record<MedRecStatus, number>;
}

/** The compose→aggregate type-boundary bridge (same as the Gate D proof): the frozen buildMemberState
 *  takes MemberEvidence (kind ∈ opd|lab|care_call); the composed evidence carries the widened
 *  kind:'admission' encounter, which the KIND-AGNOSTIC aggregation flows through structurally. */
const spineInput = (e: MemberEvidenceWithAdmission): MemberEvidence => e as unknown as MemberEvidence;

const byDateDesc = (a: { date: string }, b: { date: string }): number => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

function sideOf(o: MedicationOccurrence): MedRecSide {
  return {
    encounterRef: o.encounterRef,
    date: o.date,
    dose: o.dose ?? null,
    frequency: o.frequency ?? null,
    sourceField: o.provenance.sourceField,
    extractionMethod: o.provenance.extractionMethod,
    confidence: o.provenance.confidence,
  };
}

/** A REAL dose/frequency change only — both sides must carry the field. A null admission dose is an
 *  extraction gap, never a change. */
function doseOrFrequencyChanged(opd: MedicationOccurrence, adm: MedicationOccurrence): boolean {
  const dose = !!(opd.dose && adm.dose && opd.dose !== adm.dose);
  const freq = !!(opd.frequency && adm.frequency && opd.frequency !== adm.frequency);
  return dose || freq;
}

export interface MedRecInput {
  memberRef: string;
  generatedAt: string;
  computedAt: string;
  linked: boolean;
  prescriptionRows: Record<string, unknown>[];
  labRows: Record<string, unknown>[];
}

// gaps lead (the actionable L2 signal); stopped trails (usually documented + expected).
const SORT_ORDER: Record<MedRecStatus, number> = {
  reconciliation_gap: 0, dose_or_frequency_changed: 1, newly_started: 2, continued: 3, stopped: 4,
};

/**
 * Compose + reconcile + classify. PURE. When the flag is off, assembleEvidenceWithAdmission returns
 * the frozen output with no admission encounter — so the caller must only invoke this behind the
 * flag (the admin surface gates on admissionAdapterEnabled()).
 */
export function computeMedRecView(input: MedRecInput, episode: EpisodeState): MedRecView {
  const admissionRef = episode.episodeRef;
  // The frozen spine requires a non-empty memberRef (single-member invariant). An UNLINKED admission
  // has no OPD member key, so fall back to the admission ref itself — opaque + identifier-free, and
  // it keys a single-admission "member" whose only encounter is the discharge. hasOpdBaseline stays
  // false ⇒ admission_only mode. Without this, the ~50% unlinked tail would throw.
  const evidence = assembleEvidenceWithAdmission(
    {
      memberRef: input.memberRef || admissionRef || 'admission-only',
      generatedAt: input.generatedAt,
      sourceWatermarks: {},
      prescriptionRows: input.prescriptionRows,
      labRows: input.labRows,
    },
    episode,
  );
  const snap = buildMemberState(spineInput(evidence), input.computedAt);

  const rows: MedRecRow[] = [];
  const admissionMedications: AdmissionMed[] = [];
  const counts: Record<MedRecStatus, number> = {
    continued: 0, newly_started: 0, stopped: 0, dose_or_frequency_changed: 0, reconciliation_gap: 0,
  };

  for (const med of snap.medications) {
    const admOcc = med.occurrences.find((o) => o.encounterRef === admissionRef) ?? null;
    const opdOccs = med.occurrences.filter((o) => o.encounterRef !== admissionRef).sort(byDateDesc);
    const latestOpd = opdOccs[0] ?? null;

    if (admOcc) admissionMedications.push({ drug: med.normalizedConcept.raw, occurrence: sideOf(admOcc) });

    let status: MedRecStatus;
    if (admOcc && latestOpd) status = doseOrFrequencyChanged(latestOpd, admOcc) ? 'dose_or_frequency_changed' : 'continued';
    else if (admOcc && !latestOpd) status = 'newly_started';
    else if (!admOcc && latestOpd) status = latestOpd.stopReason ? 'stopped' : 'reconciliation_gap';
    else continue;   // no occurrence anywhere — unreachable, but never fabricate a row

    counts[status]++;
    rows.push({
      drug: med.normalizedConcept.raw,
      status,
      opdBaseline: latestOpd ? sideOf(latestOpd) : null,
      admission: admOcc ? sideOf(admOcc) : null,
    });
  }

  // no OPD baseline (unlinked, or linked with no pre-admission OPD meds) ⇒ admission-list-only. The
  // absence of a baseline MUST be visible — never render zero gaps/stops as a clean reconciliation.
  const hasOpdBaseline = snap.medications.some((m) => m.occurrences.some((o) => o.encounterRef !== admissionRef));
  const mode: MedRecView['mode'] = input.linked && hasOpdBaseline ? 'reconciliation' : 'admission_only';

  rows.sort((a, b) => SORT_ORDER[a.status] - SORT_ORDER[b.status] || a.drug.localeCompare(b.drug));
  admissionMedications.sort((a, b) => a.drug.localeCompare(b.drug));

  return { mode, linked: input.linked, admissionRef, rows, admissionMedications, counts };
}
