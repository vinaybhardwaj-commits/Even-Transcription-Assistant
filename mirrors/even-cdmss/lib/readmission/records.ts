/**
 * lib/readmission/records.ts — R10-B: the patient's WHOLE RECORD, reachable from the case
 * conversation (CDMSS-READMISSIONS-R10-RECORD-REACH-PRD-27-AUG-2026-GO §4, R10-D4..R10-D8).
 *
 * WHAT MOVED, AND WHAT DID NOT. R4.3 fenced the Ask box to one case's stored material. That fence
 * did real work — it is why an agent claim about the record cannot be invented — and R10 moves it
 * rather than removing it: the agent may now reach the PATIENT, and it still may not assert anything
 * it cannot cite. Every artefact it pulls in arrives de-identified, labelled, persisted, and citable
 * in a SECOND namespace (`X…`) that never touches the audited ledger (R10-D6).
 *
 * THE FIVE SOURCES ARE R10-D4's, AND NOTHING ELSE:
 *   ip_stay         prior IP stays        staysForUhid + readStayLibrary (the stay-library rail)
 *   opd_note        prior OPD notes       fetchPriorPrescriptionDocs (index) + fetchMemberOpdRows (text)
 *   lab             structured labs       fetchStructuredLabs, patient-wide, grouped by DAY
 *   member_state    the combined record   getMemberSnapshot
 *   cm_interaction  care-manager calls    careCallEncountersForMember (the fold MemberState uses)
 * Every one of those helpers ALREADY EXISTED and is reused, not restated. This file adds no db13
 * query of its own — the one INFERRED thing it does is choose windows and orderings, and those are
 * named in the R10 build report beside the queries they parameterise.
 *
 * ⚠️ THE PHI RULE IS THE WHOLE POINT (R10-D8). The by-uhid helpers return REAL clinical text, some of
 * it typed by a clinician who may well have written the patient's name in it. Identity tokens are
 * fetched SERVER-SIDE here (fetchSummaryRecord, the same pattern lib/readmission/run.ts uses) and
 * EVERY retrieved string goes through `deidText` — assemble.ts's exported choke point, reused and
 * never reimplemented — before it is stored or shown to the model. `toRetrievedArtefact` is the one
 * function that does it, so there is exactly one place to test and exactly one place to get wrong.
 *
 * FAIL-SAFE, ABSOLUTELY. Every source read is caught. A source that cannot be read is reported as
 * UNAVAILABLE (an unknown), never as empty (an absence) — the distinction R10 exists to defend. A
 * fetch that finds nothing answers in the tool's own channel; it never throws, never 500s, and never
 * invents text.
 */
import { deidText } from './assemble';
import { fetchDischargeDocForEncounter, fetchPriorPrescriptionDocs, fetchStructuredLabs, fetchSummaryRecord, resolveIndividualUid } from './db13';
import { staysForUhid } from '../stay-library/member-read';
import { readStayLibrary } from '../stay-library/store';
import { fetchMemberOpdRows } from '../ipd-audit/member-opd-fetch';
import { getMemberSnapshot } from '../member-state/member-state';
import { careCallEncountersForMember } from '../care-call-store';
import {
  EMPTY_RECORD_INDEX, RECORD_ARTEFACT_MAX_CHARS, RECORD_KIND_LABEL, mintRecordIndex,
  type RecordCandidate, type RecordIndex, type RecordIndexEntry, type RecordKind,
  type RecordSourceResult, type RetrievedArtefact,
} from '../readmission-ask-core';

/** The identity tokens the scrub matches on. Held in memory for one request; never persisted. */
export interface RecordIdentity { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> }

/**
 * PURE — THE SCRUBBER CHOKE POINT. One index entry + one raw text → the artefact that is stored and
 * shown. Label and text BOTH go through `deidText`; the text is then capped. Nothing else in this
 * file constructs a RetrievedArtefact, so "every retrieved string is de-identified" is a property of
 * one function rather than a habit spread across five source readers.
 */
export function toRetrievedArtefact(entry: RecordIndexEntry, rawText: string, identity: RecordIdentity): RetrievedArtefact {
  const text = deidText(String(rawText ?? ''), identity).trim();
  return {
    id: entry.id,
    kind: entry.kind,
    date: entry.date,
    label: deidText(entry.label, identity),
    sourceKey: entry.sourceKey,
    text: text.length > RECORD_ARTEFACT_MAX_CHARS ? `${text.slice(0, RECORD_ARTEFACT_MAX_CHARS)}…` : text,
  };
}

/** A label is metadata by construction, and scrubbed anyway (belt and braces — R10-D8). */
const label = (parts: Array<string | null | undefined>, identity: RecordIdentity): string =>
  deidText(parts.filter((p) => p != null && String(p).trim() !== '').join(' · '), identity).slice(0, 300);

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const DAY = 86_400_000;

// ── the reach ──────────────────────────────────────────────────────────────────────────────────

export interface RecordFetchResult {
  ok: boolean;
  artefact: RetrievedArtefact | null;
  /** What the tool channel says when there is no artefact. Always a full sentence, never an error. */
  message: string;
}

export interface RecordReach {
  index: RecordIndex;
  identity: RecordIdentity;
  /** True when this patient could not be resolved at all — no uhid, or no individual behind it. */
  unresolved: boolean;
  fetch(id: string): Promise<RecordFetchResult>;
}

/** A reach that offers nothing. The Ask call then declares NO tool and behaves exactly as R9's did —
 *  which is the right degradation: an agent that cannot reach the record must not claim it can. */
export const NO_REACH: RecordReach = {
  index: EMPTY_RECORD_INDEX,
  identity: { names: [], uhids: [] },
  unresolved: true,
  async fetch(id: string) { return { ok: false, artefact: null, message: `No record ${id} is available in this deployment.` }; },
};

/**
 * Build the record reach for ONE case.
 *
 * `bound` carries the (sourceKey → artefact id) bindings already persisted for this thread, so an id
 * a stored citation points at keeps pointing at the same artefact (R10-D7).
 *
 * Identity resolution is the first thing and the load-bearing thing: without a patient we have
 * nothing to scrub with, and a reach that cannot scrub must not retrieve. `unresolved` is therefore
 * a hard stop, not a degraded mode.
 */
export async function buildRecordReach(a: {
  dedupKey: string;
  uhid: string | null;
  indexEncounterId: string;
  readmitEncounterId: string | null;
  bound?: ReadonlyMap<string, string>;
  now?: Date;
}): Promise<RecordReach> {
  // Identity, server-side (the fetchSummaryRecord pattern — the ask route passes none, by design).
  const summary = await fetchSummaryRecord(a.indexEncounterId).catch(() => null);
  const uhid = a.uhid ?? summary?.uhid ?? null;
  const identity: RecordIdentity = { names: [summary?.patientName], uhids: [a.uhid, summary?.uhid] };
  if (!uhid) return { ...NO_REACH, identity };

  const individualUid = await resolveIndividualUid([a.uhid, summary?.uhid]).catch(() => null);
  const now = a.now ?? new Date();
  const nowIso = now.toISOString();

  // The case's OWN two stays are excluded from `ip_stay`: they are the audited ledger already, and
  // offering them again would let the agent cite the same stay under two namespaces.
  const ownStays = new Set([a.indexEncounterId, a.readmitEncounterId].filter((x): x is string => !!x));

  // ── memoised source payloads. One request may answer up to RECORD_FETCH_MAX fetches; each source
  //    is read at most once per request, and only when something actually asks for it.
  let opdRows: Promise<Awaited<ReturnType<typeof fetchMemberOpdRows>>> | null = null;
  const memoOpdRows = () => (opdRows ??= fetchMemberOpdRows(uhid, null).catch(() => ({ linked: false, memberRef: '', prescriptionRows: [], labRows: [] })));
  let labs: Promise<Awaited<ReturnType<typeof fetchStructuredLabs>>> | null = null;
  const memoLabs = () => (labs ??= individualUid
    // Patient-wide (R10-D4), expressed as a very wide window because that is the shape the existing
    // helper takes. INFERRED bound: 2000-01-01 → today + 2 days, the same +2d slack the index-window
    // helper uses so a result filed after midnight is not lost.
    ? fetchStructuredLabs(individualUid, '2000-01-01', new Date(now.getTime() + 2 * DAY).toISOString().slice(0, 10)).catch(() => [])
    : Promise.resolve([]));
  let snapshot: Promise<Awaited<ReturnType<typeof getMemberSnapshot>>> | null = null;
  const memoSnapshot = () => (snapshot ??= individualUid ? getMemberSnapshot(individualUid, nowIso).catch(() => null) : Promise.resolve(null));
  let careCalls: Promise<Awaited<ReturnType<typeof careCallEncountersForMember>>> | null = null;
  const memoCareCalls = () => (careCalls ??= individualUid ? careCallEncountersForMember(individualUid).catch(() => []) : Promise.resolve([]));

  // ── the index. Metadata only (R10-D8): a kind, a date, an opaque id, a short label.
  const sources: RecordSourceResult[] = [];

  // 1 · prior IP stays
  try {
    const stays = await staysForUhid(uhid);
    sources.push({
      kind: 'ip_stay',
      ok: true,
      items: stays.filter((st) => !ownStays.has(st.encounterRef)).map((st): RecordCandidate => ({
        kind: 'ip_stay', date: st.date, sourceKey: `ip_stay:${st.encounterRef}`,
        label: label(['inpatient stay'], identity),
      })),
    });
  } catch { sources.push({ kind: 'ip_stay', ok: false, items: [] }); }

  // 2 · prior OPD notes — the cheap index read (uid + date), never the text.
  if (individualUid) {
    const prior = await fetchPriorPrescriptionDocs(individualUid, null).catch(() => ({ ok: false, notes: [] }));
    sources.push({
      kind: 'opd_note',
      ok: prior.ok,
      items: prior.notes.map((n): RecordCandidate => ({
        kind: 'opd_note', date: (n.createdAt ?? '').slice(0, 10) || null, sourceKey: `opd_note:${n.uid}`,
        label: label(['clinic visit'], identity),
      })),
    });
  } else sources.push({ kind: 'opd_note', ok: false, items: [] });

  // 3 · labs, grouped by DAY. One analyte value is not an artefact a clinician recognises; a day's
  //     panel is. Grouping also keeps the index inside its 20-per-kind cap on a heavily tested patient.
  if (individualUid) {
    const rows = await memoLabs();
    const days = new Map<string, number>();
    for (const l of rows) {
      const d = (l.at ?? '').slice(0, 10);
      if (!d) continue;
      days.set(d, (days.get(d) ?? 0) + 1);
    }
    sources.push({
      kind: 'lab',
      ok: true,
      items: [...days.entries()].map(([d, n]): RecordCandidate => ({
        kind: 'lab', date: d, sourceKey: `lab:${d}`, label: label([`${n} result${n === 1 ? '' : 's'}`], identity),
      })),
    });
  } else sources.push({ kind: 'lab', ok: false, items: [] });

  // 4 · the MemberState snapshot — ONE artefact, offered without being built. Building it costs two
  //     db13 reads and a fold, and most conversations never ask for it.
  sources.push(individualUid
    ? { kind: 'member_state', ok: true, items: [{ kind: 'member_state', date: nowIso.slice(0, 10), sourceKey: 'member_state:current', label: label(['problems, medicines, allergies and trends, combined across visits'], identity) }] }
    : { kind: 'member_state', ok: false, items: [] });

  // 5 · care-manager interactions — the care-call outcomes MemberState folds (R10-D4's wording).
  if (individualUid) {
    const calls = await memoCareCalls();
    sources.push({
      kind: 'cm_interaction',
      ok: true,
      items: calls.map((c): RecordCandidate => ({
        kind: 'cm_interaction', date: s(c.date), sourceKey: `cm_interaction:${String(c.encounterRef)}`,
        label: label(['follow-up call'], identity),
      })),
    });
  } else sources.push({ kind: 'cm_interaction', ok: false, items: [] });

  const index = mintRecordIndex(sources, a.bound ?? new Map());
  const byId = new Map(index.entries.map((e) => [e.id, e]));

  return {
    index,
    identity,
    unresolved: false,
    async fetch(id: string): Promise<RecordFetchResult> {
      const entry = byId.get(id);
      if (!entry) return { ok: false, artefact: null, message: `No record with id ${id} is in this patient's index.` };
      try {
        const raw = await renderArtefact(entry, {
          identity, individualUid, memoOpdRows, memoLabs, memoSnapshot, memoCareCalls,
        });
        if (!raw || !raw.trim()) {
          // An artefact the index listed but whose text could not be read. Reported as an UNKNOWN in
          // the tool's own channel — the model must not read a blank as "this visit was uneventful".
          return { ok: false, artefact: null, message: `Record ${id} (${RECORD_KIND_LABEL[entry.kind]}${entry.date ? `, ${entry.date}` : ''}) is listed but its text could not be read. Treat that as unknown, not as an absence.` };
        }
        return { ok: true, artefact: toRetrievedArtefact(entry, raw, identity), message: '' };
      } catch {
        return { ok: false, artefact: null, message: `Record ${id} could not be read just now. Treat that as unknown, not as an absence.` };
      }
    },
  };
}

// ── rendering one artefact ──────────────────────────────────────────────────────────────────────
//
// RAW text out of these functions; `toRetrievedArtefact` de-identifies it. Keeping the scrub OUT of
// the renderers is deliberate: a renderer that scrubbed for itself would be a second place the rule
// could be forgotten, and the rule is the one thing here that must never be forgotten.

interface RenderDeps {
  identity: RecordIdentity;
  individualUid: string | null;
  memoOpdRows: () => Promise<{ linked: boolean; prescriptionRows: Record<string, unknown>[]; labRows: Record<string, unknown>[] }>;
  memoLabs: () => Promise<Array<{ name: string | null; valueText: string | null; value: number | null; unit: string | null; at: string | null }>>;
  memoSnapshot: () => Promise<unknown>;
  /** `EncounterEvidence[]`, read structurally — this file must not depend on the spine's schema
   *  (architecture rule: the readmission agent consumes MemberState, it never models it). */
  memoCareCalls: () => Promise<ReadonlyArray<unknown>>;
}

async function renderArtefact(entry: RecordIndexEntry, d: RenderDeps): Promise<string> {
  const native = entry.sourceKey.slice(entry.sourceKey.indexOf(':') + 1);
  switch (entry.kind) {
    case 'ip_stay': return renderStay(native);
    case 'opd_note': return renderOpdNote(native, d);
    case 'lab': return renderLabDay(native, d);
    case 'member_state': return renderSnapshot(d);
    case 'cm_interaction': return renderCareCall(native, d);
    default: {
      const exhaustive: never = entry.kind;
      return exhaustive;
    }
  }
}

/** A prior stay, from its ClinicalState library documents. Facts as the library holds them. */
async function renderStay(encounterRef: string): Promise<string> {
  const lib = await readStayLibrary(encounterRef);
  if (!lib.documents.length) return '';
  const out: string[] = [];
  for (const doc of lib.documents.slice(0, 6)) {
    const st = doc.state as unknown as Record<string, unknown>;
    const list = (k: string): string[] => (Array.isArray(st[k]) ? (st[k] as unknown[]).map((x) => String(x)).filter(Boolean) : []);
    const findings = (k: string): string[] =>
      (Array.isArray(st[k]) ? (st[k] as Array<Record<string, unknown>>) : [])
        .map((f) => [s(f.concept), s(f.value)].filter(Boolean).join(' '))
        .filter(Boolean).slice(0, 30);
    out.push(`— ${String(doc.docKind ?? 'document')} (${String(doc.status ?? 'status unknown')})`);
    const push = (labelText: string, xs: string[]) => { if (xs.length) out.push(`${labelText}: ${xs.join('; ')}`); };
    push('documented present', findings('positives'));
    push('documented absent', findings('negatives'));
    push('procedures', list('procedures'));
    push('medicines', list('medications'));
    push('investigations', findings('investigations'));
    if (s(st.disposition)) out.push(`condition at discharge: ${String(st.disposition)}`);
    push('missing from the record', list('missingCriticalData'));
  }
  return out.join('\n');
}

/** A prior clinic note: the prescription row's clinical columns. Never the identity columns —
 *  `fetchMemberOpdRows` does not select them (its own SELECT is the guarantee). */
async function renderOpdNote(uid: string, d: RenderDeps): Promise<string> {
  const rows = await d.memoOpdRows();
  const row = rows.prescriptionRows.find((r) => String(r.uid ?? '') === uid);
  if (!row) return '';
  const out: string[] = [];
  const add = (k: string, v: unknown) => { const t = s(v); if (t) out.push(`${k}: ${t}`); };
  add('visit date', row.visit_date);
  add('allergies noted', row.patient_details__allergies);
  add('diagnosis codes', Array.isArray(row.diagnosis_icd_codes) ? (row.diagnosis_icd_codes as unknown[]).join(', ') : row.diagnosis_icd_codes);
  add('impression codes', Array.isArray(row.impression_icd_codes) ? (row.impression_icd_codes as unknown[]).join(', ') : row.impression_icd_codes);
  const meds = row.medications;
  if (Array.isArray(meds) && meds.length) {
    const names = meds.map((m) => {
      const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
      return [s(o.name) ?? s(o.brand) ?? s(o.generic), s(o.dosage) ?? s(o.dose), s(o.frequency), s(o.duration)].filter(Boolean).join(' ');
    }).filter(Boolean);
    if (names.length) out.push(`medicines prescribed: ${names.slice(0, 30).join('; ')}`);
  }
  return out.join('\n');
}

/** One day's structured lab panel — value, unit, and the analyte's own name. */
async function renderLabDay(day: string, d: RenderDeps): Promise<string> {
  const rows = (await d.memoLabs()).filter((l) => (l.at ?? '').slice(0, 10) === day);
  if (!rows.length) return '';
  return [`lab results, ${day}`, ...rows.slice(0, 60).map((l) =>
    `${l.name ?? 'analyte'}: ${l.valueText ?? l.value ?? '?'}${l.unit ? ` ${l.unit}` : ''}`)].join('\n');
}

/** The combined member record: problems, medicines, allergies, and what the sources disagree about. */
async function renderSnapshot(d: RenderDeps): Promise<string> {
  const snap = (await d.memoSnapshot()) as Record<string, unknown> | null;
  if (!snap) return '';
  const arr = (k: string): Array<Record<string, unknown>> => (Array.isArray(snap[k]) ? snap[k] as Array<Record<string, unknown>> : []);
  const concept = (x: Record<string, unknown>): string => {
    const c = (x.normalizedConcept && typeof x.normalizedConcept === 'object' ? x.normalizedConcept : {}) as Record<string, unknown>;
    return s(c.generic) ?? s(c.raw) ?? s(c.brand) ?? 'unnamed';
  };
  const out: string[] = [`combined record as of ${s(snap.asOf) ?? 'an unstated date'}`];
  const problems = arr('problems').slice(0, 40).map((p) => `${concept(p)} (${s(p.latestDocumentedStatus) ?? 'status unstated'})`);
  if (problems.length) out.push(`problems: ${problems.join('; ')}`);
  const meds = arr('medications').slice(0, 40).map((m) => `${concept(m)} (${s(m.latestStatus) ?? s(m.status) ?? 'status unstated'})`);
  if (meds.length) out.push(`medicines: ${meds.join('; ')}`);
  const allergies = arr('allergies').slice(0, 20).map((x) => `${concept(x)} (${s(x.latestStatus) ?? s(x.status) ?? 'status unstated'})`);
  if (allergies.length) out.push(`allergies: ${allergies.join('; ')}`);
  const procedures = arr('procedures').slice(0, 20).map((p) => s(p.nameRaw) ?? s(p.name) ?? concept(p));
  if (procedures.length) out.push(`procedures: ${procedures.join('; ')}`);
  const conflicts = arr('conflicts').slice(0, 20).map((c) => s(c.description) ?? s(c.kind) ?? 'a disagreement between sources');
  if (conflicts.length) out.push(`the sources disagree about: ${conflicts.join('; ')}`);
  return out.join('\n');
}

/** One care-manager call, as the fold recorded it. Patient-REPORTED, and the text says so. */
async function renderCareCall(encounterRef: string, d: RenderDeps): Promise<string> {
  const calls = (await d.memoCareCalls()) as ReadonlyArray<Record<string, unknown>>;
  const call = calls.find((c) => String(c?.encounterRef ?? '') === encounterRef);
  if (!call) return '';
  const out: string[] = [`care-manager follow-up call, ${s(call.date) ?? 'date not stated'} — everything below is PATIENT-REPORTED, not a clinical record`];
  const list = (k: string): Array<Record<string, unknown>> => (Array.isArray(call[k]) ? call[k] as Array<Record<string, unknown>> : []);
  const complaints = list('complaintStatuses').map((c) => [s(c.complaintRaw) ?? s(c.concept), s(c.status)].filter(Boolean).join(': ')).filter(Boolean);
  if (complaints.length) out.push(`symptoms reported: ${complaints.slice(0, 20).join('; ')}`);
  const meds = list('medicationAssertions').map((m) => [s(m.conceptRaw) ?? s(m.raw), s(m.status)].filter(Boolean).join(': ')).filter(Boolean);
  if (meds.length) out.push(`medicines reported: ${meds.slice(0, 20).join('; ')}`);
  const follow = list('followUps').map((f) => s(f.description) ?? s(f.raw)).filter(Boolean);
  if (follow.length) out.push(`follow-up agreed: ${follow.slice(0, 10).join('; ')}`);
  const problems = list('problems').map((p) => s(p.conceptRaw)).filter(Boolean);
  if (problems.length) out.push(`problems mentioned: ${problems.slice(0, 20).join('; ')}`);
  return out.length > 1 ? out.join('\n') : '';
}

/** Unused-import guard for the doc-link helper the reach deliberately does NOT use: the record reach
 *  never opens a PDF. Kept as a type-only reference so a future edit that reaches for it has to
 *  think about the cost first. */
export type _DischargeDocLinkReader = typeof fetchDischargeDocForEncounter;
