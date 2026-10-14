/**
 * lib/ipd-episode/assemble.ts — the IMPURE half of episode assembly: call the db13 readers, run
 * the rows through the pure core, and hand back ONE ordered event list plus the envelope the rest
 * of the pipeline needs.
 *
 * THE SINGLE LIST IS THE POINT. Assembly builds every event once, including the discharge event
 * and the extracted case it carries (PRD §3.2.4). Blinding is NOT a second assembly path — it is a
 * FILTER over this list, applied where inputs are built (assemble-core's `eventsBeforeDayStart`,
 * `episodeLevelEvents`, `diffPassEvents`, `fidelityPassEvents`). Two assembly paths is how a
 * blinded pass quietly stops being blinded.
 *
 * DE-IDENTIFICATION IS AN ARGUMENT, NOT A STEP (the stay-library idiom). The identity to scrub
 * against is read at assembly time from the EXISTING render-time header reader in
 * lib/ipd-audit/db13.ts — the one place in the repo licensed to see a name — and is used only to
 * build the scrubber. It is never stored, never returned, and never reaches a prompt. Without it
 * the scrub falls back to shape-only and that fact is recorded in `notes`, never hidden.
 *
 * ⚠️ THIS IS LITERALLY THE STAY-LIBRARY DE-IDENTIFIER, and it is worth naming why it arrives in two
 * imports rather than one. PRD §12 lists the de-identifier as "the `Deidentifier` used by
 * lib/stay-library/core.ts" — but that module exports `Deidentifier` only as a TYPE
 * (core.ts:259). It holds no concrete scrubber to import: the function it is bound to is
 * `deidText` from lib/readmission/assemble.ts, wired up in lib/stay-library/build.ts:134 as
 * `(text) => deidText(text, identity)`. The two lines below are that same construction, taking the
 * type from core.ts and the function from where build.ts takes it, so this engine and the stay
 * library scrub through one implementation. Nothing on the UNTOUCHED list had to change for it.
 */

import { deidText } from '../readmission/assemble';
import { fetchIpdAdmissionHeader } from '../ipd-audit/db13';
import type { Deidentifier } from '../stay-library/core';
import {
  fetchAdmission, fetchDischargeSummary, fetchProgressNotes, fetchInitialAssessments,
  fetchShiftHandovers, fetchOtNotes, fetchBillingOrders, fetchLabOrders, fetchTransfers,
  type Db13Row,
} from './db13';
import {
  buildOrderEvents, componentValue, dayIndexFor, isoFromEpochMs, isoFromTimestamp, losDaysFor,
  noteSummaryFrom, normalizeAuthorName, parseComponentJson, queryNarrativeFrom, sortEvents,
  type BillingOrderRow, type EpisodeEvent, type EpisodeEventType,
} from './assemble-core';

const s = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim());

export interface EpisodeEnvelope {
  encounterId: string;
  memberId: string | null;
  facilityName: string | null;
  speciality: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  losDays: number | null;
  dischargeType: string | null;
  treatingDepartmentName: string | null;
  admissionType: string | null;
  admitSource: string | null;
  remarks: string | null;
  responsibleClinicianId: string | null;
}

export interface AssembledEpisode {
  envelope: EpisodeEnvelope;
  /** THE single event list. Every pass input is a filter over this. */
  events: EpisodeEvent[];
  /** Which of the nine completeness sources actually returned a row. */
  sourcesPresent: string[];
  notes: string[];
}

export interface AssembleInput {
  encounterId: string;
  /** The stored `extracted_json` for this episode, already de-identified by its extractor. */
  extractedCase: unknown;
  extractionVersion: string | null;
}

/**
 * The clinical timestamp for a template row: `progressnote_date_time` out of the component array
 * (epoch ms, present on 1,464 of 1,464 progress notes), then `g_creation_time` (epoch ms).
 * NEVER `_create_time` (the mirror's ingest time) and NEVER `created_at` (agrees with the
 * clinician-stated time on 20% of rows, null on 148). Null when neither resolves → Tier C.
 */
export function templateClinicalTime(entries: { name: string; valueString: string }[], row: Db13Row): string | null {
  return isoFromEpochMs(componentValue(entries, 'progressnote_date_time')) ?? isoFromEpochMs(row.g_creation_time);
}

/** One template row → one event. Shared by notes, initial assessments, handovers and OT notes. */
function templateEvent(
  row: Db13Row, table: string, type: EpisodeEventType, tier: 'A' | 'B',
  admissionIso: string, deid: Deidentifier, extraDetail: Record<string, unknown> = {},
): EpisodeEvent {
  const entries = parseComponentJson(row.component_json);
  const occurred_at = templateClinicalTime(entries, row);
  const recordId = s(row._doc_id) ?? `${table}:unknown`;
  return {
    event_id: `${type}-${recordId}`,
    occurred_at,
    day_index: dayIndexFor(admissionIso, occurred_at),
    event_type: type,
    summary: noteSummaryFrom(entries, deid),
    detail: {
      template_name: s(row.template_name),
      status: s(row.status),
      // ⚠️ THE RETRIEVAL-SAFE NARRATIVE, built from the whitelist and carried on the event so the
      // query builder never has to strip the full summary again (item 7). The full `summary` above
      // remains the RECORD — everything the note said — and is what the prompts and the UI read.
      query_narrative: queryNarrativeFrom(entries),
      ...extraDetail,
    },
    author_name: normalizeAuthorName(row.finalized_by_username),
    author_role: componentValue(entries, 'role'),
    responsible_clinician_id: s(row.current_treating_doctor_id),
    provenance: { source_table: table, source_record_id: recordId, source_timestamp: occurred_at },
    // §3.2.2: an event with no resolved clinical time is Tier C whatever its table would give it.
    evidence_tier: occurred_at ? tier : 'C',
  };
}

/**
 * Assemble one episode. Every reader is fail-safe (an unreachable table yields []), so a partial
 * mirror produces a thinner course with a lower completeness score — never a failed episode and
 * never an invented event. `null` only when the admission row itself is missing, which selection
 * has already ruled out.
 */
export async function assembleEpisode(input: AssembleInput): Promise<AssembledEpisode | null> {
  const notes: string[] = [];
  const encounterId = input.encounterId;

  const [admission, discharge] = await Promise.all([
    fetchAdmission(encounterId),
    fetchDischargeSummary(encounterId),
  ]);
  if (!admission) return null;

  const admittedAt = isoFromTimestamp(admission.admission_date_time);
  if (!admittedAt) {
    notes.push('the admission row carries no readable admission_date_time — day indices cannot be computed');
    return null;
  }
  const dischargedAt = isoFromTimestamp(discharge?.discharge_date_time);

  // The identity to scrub against, from the EXISTING render-time reader. Never stored, never
  // returned, never in a prompt — it exists only to build the de-identifier below.
  const header = await fetchIpdAdmissionHeader(encounterId).catch(() => null);
  if (!header) notes.push('no admission header for this episode — de-identification falls back to shape-only');
  const identity = { names: [header?.patientName ?? null], uhids: [header?.uhid ?? null] };
  const deid: Deidentifier = (text: string) => deidText(text, identity);

  const [progressNotes, initialAssessments, handovers, otNotes, billing, labs, transfers] = await Promise.all([
    fetchProgressNotes(encounterId),
    fetchInitialAssessments(encounterId),
    fetchShiftHandovers(encounterId),
    fetchOtNotes(encounterId),
    fetchBillingOrders(encounterId),
    fetchLabOrders(encounterId),
    fetchTransfers(encounterId),
  ]);

  const events: EpisodeEvent[] = [];

  // ── admission (Tier A, day 0 by construction) ──
  events.push({
    event_id: `admission-${encounterId}`,
    occurred_at: admittedAt,
    day_index: 0,
    event_type: 'admission',
    summary: [
      s(admission.admission_type) ? `Admission type ${s(admission.admission_type)}` : null,
      s(admission.admit_source) ? `from ${s(admission.admit_source)}` : null,
      s(admission.treating_department_name) ? `to ${s(admission.treating_department_name)}` : null,
      s(admission.ward) ? `ward ${s(admission.ward)}` : null,
    ].filter(Boolean).join(' · ') || 'Admission',
    detail: {
      admission_type: s(admission.admission_type),
      admit_source: s(admission.admit_source),
      ward: s(admission.ward),
      ward_type_name: s(admission.ward_type_name),
      billing_category: s(admission.billing_category),
      treating_department_name: s(admission.treating_department_name),
      treating_sub_department_name: s(admission.treating_sub_department_name),
      admitting_doctor_speciality: s(admission.admitting_doctor_speciality),
      current_treating_doctor_speciality: s(admission.current_treating_doctor_speciality),
      facility_name: s(admission.facility_name),
      remarks: s(admission.remarks) ? deid(String(admission.remarks)) : null,
    },
    author_name: null,
    author_role: null,
    responsible_clinician_id: s(admission.current_treating_doctor_id),
    provenance: {
      source_table: 'kx_ip_admissions',
      source_record_id: s(admission.uid) ?? encounterId,
      source_timestamp: admittedAt,
    },
    evidence_tier: 'A',
  });

  for (const r of progressNotes) events.push(templateEvent(r, 'kx_clinical_template_progress_reports', 'note', 'A', admittedAt, deid));
  for (const r of initialAssessments) events.push(templateEvent(r, 'kx_clinical_template_initial_assessment_adults', 'initial_assessment', 'B', admittedAt, deid));
  for (const r of handovers) {
    events.push(templateEvent(r, 'kx_clinical_template_shift_handovers', 'handover', 'B', admittedAt, deid, {
      handed_over_by: s(r.handed_over_by), received_by: s(r.received_by), handover_route: s(r.handover_route),
    }));
  }
  for (const r of otNotes) {
    events.push(templateEvent(r, 'kx_clinical_template_ot_notes', 'ot_note', 'B', admittedAt, deid, {
      surgery_name: s(r.surgery_name), surgeon: s(r.surgeon),
    }));
  }

  // ── orders (roll-ups and per-day caps live in the pure core) ──
  events.push(...buildOrderEvents(billing as BillingOrderRow[], admittedAt));

  // ── lab orders: one event per row (§3.2.3 order rules name labs one per order_no; the mirror
  //    carries one row per ordered service, and the row's own _doc_id is its provenance) ──
  for (const r of labs) {
    const occurred_at = isoFromTimestamp(r.sample_collection_date_time) ?? isoFromTimestamp(r.booking_date_time);
    const recordId = s(r._doc_id) ?? `lab:${s(r.order_no) ?? 'unknown'}`;
    events.push({
      event_id: `lab_order-${recordId}`,
      occurred_at,
      day_index: dayIndexFor(admittedAt, occurred_at),
      event_type: 'lab_order',
      summary: `Lab order · ${s(r.service_name) ?? '(unnamed test)'}${s(r.priority) ? ` (${s(r.priority)})` : ''}`,
      detail: {
        order_no: s(r.order_no),
        service_name: s(r.service_name),
        sub_department: s(r.sub_department),
        priority: s(r.priority),
        booking_date_time: isoFromTimestamp(r.booking_date_time),
        sample_collection_date_time: isoFromTimestamp(r.sample_collection_date_time),
        report_date: isoFromTimestamp(r.report_date),
        icd_diagnosis: s(r.icd_diagnosis),
        // Stated on every lab event because it bounds what any finding may claim: this table
        // carries order and report METADATA. There are no result values anywhere in the mirror.
        results_available: false,
      },
      author_name: null,
      author_role: null,
      responsible_clinician_id: null,
      provenance: { source_table: 'kx_lab_reports', source_record_id: recordId, source_timestamp: occurred_at },
      evidence_tier: occurred_at ? 'A' : 'C',
    });
  }

  // ── transfers (created_at is this table's only timestamp; §3.2.2 names it) ──
  for (const r of transfers) {
    const occurred_at = isoFromTimestamp(r.created_at);
    const recordId = s(r._doc_id) ?? `transfer:${encounterId}`;
    events.push({
      event_id: `transfer-${recordId}`,
      occurred_at,
      day_index: dayIndexFor(admittedAt, occurred_at),
      event_type: 'transfer',
      summary: `Transfer · ${s(r.transfer_type) ?? 'unspecified'}${s(r.ward) ? ` to ${s(r.ward)}` : ''}`,
      detail: {
        transfer_type: s(r.transfer_type),
        transfer_reason: s(r.transfer_reason) ? deid(String(r.transfer_reason)) : null,
        ward: s(r.ward),
        vacant_ward_name: s(r.vacant_ward_name),
        care_type: s(r.care_type),
        recommending_doctor_speciality: s(r.recommending_doctor_speciality),
      },
      author_name: null,
      author_role: null,
      responsible_clinician_id: null,
      provenance: { source_table: 'kx_ip_transfers', source_record_id: recordId, source_timestamp: occurred_at },
      evidence_tier: occurred_at ? 'B' : 'C',
    });
  }

  // ── discharge (assembled ONCE, carrying the extracted case; every blinded input filters it out) ──
  if (discharge && dischargedAt) {
    const recordId = s(discharge._doc_id) ?? `discharge:${encounterId}`;
    events.push({
      event_id: `discharge-${recordId}`,
      occurred_at: dischargedAt,
      day_index: dayIndexFor(admittedAt, dischargedAt),
      event_type: 'discharge',
      summary: `Discharge · ${s(discharge.discharge_type) ?? 'type not recorded'}`,
      detail: {
        discharge_type: s(discharge.discharge_type),
        treating_doctor_speciality: s(discharge.treating_doctor_speciality),
        extraction_version: input.extractionVersion,
        extracted_case: input.extractedCase ?? null,
      },
      author_name: null,
      author_role: null,
      responsible_clinician_id: s(admission.current_treating_doctor_id),
      provenance: { source_table: 'kx_discharge_summary_records', source_record_id: recordId, source_timestamp: dischargedAt },
      evidence_tier: 'A',
    });
  } else {
    notes.push('no readable discharge_date_time on the closing summary row — no discharge event was assembled');
  }

  const sourcesPresent: string[] = ['kx_ip_admissions'];
  if (progressNotes.length) sourcesPresent.push('kx_clinical_template_progress_reports');
  if (billing.length) sourcesPresent.push('kx_billing_records');
  if (labs.length) sourcesPresent.push('kx_lab_reports');
  if (discharge) sourcesPresent.push('kx_discharge_summary_records');
  if (initialAssessments.length) sourcesPresent.push('kx_clinical_template_initial_assessment_adults');
  if (handovers.length) sourcesPresent.push('kx_clinical_template_shift_handovers');
  if (otNotes.length) sourcesPresent.push('kx_clinical_template_ot_notes');
  if (transfers.length) sourcesPresent.push('kx_ip_transfers');

  const envelope: EpisodeEnvelope = {
    encounterId,
    memberId: s(admission.member_id),
    facilityName: s(admission.facility_name),
    speciality: s(admission.current_treating_doctor_speciality) ?? s(admission.admitting_doctor_speciality),
    admittedAt,
    dischargedAt,
    losDays: losDaysFor(admittedAt, dischargedAt),
    dischargeType: s(discharge?.discharge_type),
    treatingDepartmentName: s(admission.treating_department_name),
    admissionType: s(admission.admission_type),
    admitSource: s(admission.admit_source),
    remarks: s(admission.remarks) ? deid(String(admission.remarks)) : null,
    responsibleClinicianId: s(admission.current_treating_doctor_id),
  };

  return { envelope, events: sortEvents(events), sourcesPresent, notes };
}
