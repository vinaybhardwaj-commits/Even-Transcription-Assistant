// lib/member-state/vitals-read.ts — MemberState clinical-state redesign, the READ-ONLY vitals/modality
// side-channel (Decision C + §2.3/§2.4). Server-only; reads db13 THROUGH Metabase (same discipline as
// lib/metabase.ts). SOFT-FAIL by construction: any error / missing data ⇒ absent (never throws to the
// page). These values are passed to the components AS PROPS — they do NOT enter EncounterEvidence or
// buildMemberState, and the frozen reconciliation snapshot is unchanged.
//
// SQL is VERBATIM from PRD §2.4. The `..._vitals` column is a CATEGORICAL enum (assessment modality) —
// NEVER parsed for numbers (0/57,917 rows contain a digit). Structured numeric vitals exist only for
// the recent in-person cohort; longitudinal-only members (e.g. Ravali) legitimately have none.

import { metabaseQuery } from '../metabase';
import { isUid } from '../ccb-dossier-core';
import type { VitalsRead, ModalityMix } from './present-augment';
import { EMPTY_MODALITY } from './present-augment';

export interface MemberVitals {
  latest: VitalsRead | null;   // most-recent structured vitals row (numeric)
  trend: VitalsRead[];         // recent rows (newest-first) for a stability read
  modality: ModalityMix;       // per-member assessment-modality mix (from the prescription join)
}
export const EMPTY_MEMBER_VITALS: MemberVitals = { latest: null, trend: [], modality: EMPTY_MODALITY };

const str = (v: unknown): string | null => { const s = v === null || v === undefined ? '' : String(v).trim(); return s ? s : null; };
const int = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };

function toVitalsRead(r: Record<string, unknown>): VitalsRead {
  return {
    createdAt: str(r.created_at),
    bp: str(r.bp), bpTag: str(r.bp_tag),
    pulse: str(r.pulse), pulseTag: str(r.pulse_tag),
    spo2: str(r.spo2), spo2Tag: str(r.spo2_tag),
    temp: str(r.temp), tempTag: str(r.temp_tag),
    rr: str(r.rr),
    ews: int(r.ews), ewsTag: str(r.ews_tag), ewsDesc: str(r.ews_desc),
  };
}
function hasAnyVital(v: VitalsRead): boolean {
  return !!(v.bp || v.pulse || v.spo2 || v.temp || v.rr);
}

// ── VERBATIM SQL (PRD §2.4) ──────────────────────────────────────────────────────
/** Member latest structured vitals (+ EWS, tags). Trend: this fetches all recent rows (newest-first). */
const memberVitalsSql = (individualUid: string): string => {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  return `SELECT created_at, source, prescription_uid, consult_uid,
       measurements__blood_pressure AS bp, measurements__blood_pressure_tag AS bp_tag,
       measurements__pulse_rate AS pulse, measurements__pulse_rate_tag AS pulse_tag,
       measurements__spo2_level AS spo2, measurements__spo2_level_tag AS spo2_tag,
       measurements__temperature AS temp, measurements__temperature_tag AS temp_tag,
       measurements__respiratory_value AS rr,
       measurements__early_warning_score AS ews,
       measurements__early_warning_score_tag AS ews_tag,
       measurements__early_warning_score_description AS ews_desc
FROM "individuals-individual_vitals_records"
WHERE uid = '${individualUid}'
ORDER BY created_at DESC
LIMIT 20`;
};

/** Modality enum per encounter + member mix (from the prescription join). Values are CATEGORICAL. */
const modalitySql = (individualUid: string): string => {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  return `SELECT p._doc_id AS presc_uid, p.uploaded_at,
       p.general_practitioner_prescription__vitals AS assess_mode,
       p.vitals__vitals_measurements AS vitals_json
FROM dpipe_prescription_pipeline dp
JOIN "individuals-prescriptions" p ON p._doc_id = dp.presc_uid
WHERE dp.individual_uid = '${individualUid}'
ORDER BY p.uploaded_at DESC
LIMIT 200`;
};

// ── D-A: presc_uid → consult_uid (VITALS-SOURCE / CHEAP-DEFECT-BATCH §4.1) ───────────────────
// MEASURED on individuals-individual_vitals_records (2 Aug 2026, whole table, 5,275 rows):
// consult_uid is populated on 5,253 (99.6%); prescription_uid on 308 (5.8%). readEncounterVitals
// matched the open visit on prescription_uid alone, so it found that visit AT MOST 5.8 times in
// 100. The nurse files vitals against the CONSULTATION, not the prescription document — which is
// the same join key lib/metabase.ts:91 (joinVitals) already uses for the audit path.
//
// Shape copied from individualUidForPresc (lib/member-state/member-state.ts:48): the isUid guard
// before the string reaches the SQL, and the .catch(() => []) soft-fail so a Metabase error
// degrades to "no consult id" and the caller falls back to the old key — never a throw onto a
// clinical screen.
export const consultForPrescSql = (prescUid: string): string => {
  if (!isUid(prescUid)) throw new Error('bad presc uid');
  return `SELECT consult_uid FROM "individuals-prescriptions" WHERE uid = '${prescUid}' LIMIT 1`;
};

export async function consultUidForPresc(prescUid: string): Promise<string | null> {
  if (!isUid(prescUid)) return null;
  const rows = await metabaseQuery(consultForPrescSql(prescUid)).catch(() => [] as Record<string, unknown>[]);
  const u = rows[0]?.consult_uid ? String(rows[0].consult_uid) : '';
  return isUid(u) ? u : null;
}

// D-B: "no data" is not "remote care" (CHEAP-DEFECT-BATCH §4.2).
// MEASURED 2 Aug 2026: general_practitioner_prescription__vitals — the source of assess_mode — has
// been EMPTY on all 52,439 prescriptions since 1 April 2026 (it was partially filled to March, then
// died). Every row therefore fell to 'UNDOCUMENTED', inPerson stayed 0, and the ladder's final
// `: 'remote'` branch made majority 'remote' FOR EVERY MEMBER. Three surfaces then stated that the
// member had only ever had remote or undocumented care, which is a claim about the clinician, not
// about the data — and it is false.
//
// `documented` counts rows that actually carry a modality. When none do and there are still visits,
// the honest answer is 'unknown': we do not know how this member was assessed. The rest of the
// ladder is UNCHANGED — a member with real modality data is classified exactly as before.
function summariseModality(rows: Record<string, unknown>[]): ModalityMix {
  const counts: Record<string, number> = {};
  let inPerson = 0, remoteOrUndoc = 0, total = 0, documented = 0;
  let lastAssessMode: string | null = null, lastAssessAt: string | null = null;
  for (const r of rows) {
    total++;
    const raw = str(r.assess_mode);
    if (raw) documented++;
    const mode = (raw || 'UNDOCUMENTED').toUpperCase();
    counts[mode] = (counts[mode] ?? 0) + 1;
    if (lastAssessMode === null) { lastAssessMode = mode; lastAssessAt = str(r.uploaded_at); }
    if (mode === 'IN_PERSON') inPerson++;
    else remoteOrUndoc++;
  }
  const majority: ModalityMix['majority'] = total === 0 ? 'unknown'
    : documented === 0 ? 'unknown'          // D-B: visits exist, but the field that says how is empty
    : inPerson > total / 2 ? 'in_person'
    : inPerson > 0 ? 'mixed'
    : 'remote';
  return { total, counts, documented, inPerson, remoteOrUndocumented: remoteOrUndoc, majority, lastAssessMode, lastAssessAt };
}

async function fetchRows(individualUid: string): Promise<{ vitals: VitalsRead[]; prescOf: (string | null)[]; consultOf: (string | null)[]; modality: ModalityMix }> {
  const [vitalsRows, modalityRows] = await Promise.all([
    metabaseQuery(memberVitalsSql(individualUid)).catch(() => [] as Record<string, unknown>[]),
    metabaseQuery(modalitySql(individualUid)).catch(() => [] as Record<string, unknown>[]),
  ]);
  return {
    vitals: vitalsRows.map(toVitalsRead),
    prescOf: vitalsRows.map((r) => str(r.prescription_uid)),
    consultOf: vitalsRows.map((r) => str(r.consult_uid)),
    modality: summariseModality(modalityRows),
  };
}

/** Whole-member vitals + modality mix (for the workspace panel). Soft-fails to EMPTY_MEMBER_VITALS. */
export async function readMemberVitals(individualUid: string): Promise<MemberVitals> {
  if (!isUid(individualUid)) return EMPTY_MEMBER_VITALS;
  const { vitals, modality } = await fetchRows(individualUid);
  const trend = vitals.filter(hasAnyVital);
  return { latest: trend[0] ?? null, trend, modality };
}

/** Single-encounter vitals: the vitals row for THIS prescription, plus the member modality mix.
 *  `individualUid` is resolved by the caller (the route already bridges presc_uid → individual_uid). */
export async function readEncounterVitals(individualUid: string, prescUid: string): Promise<MemberVitals> {
  if (!isUid(individualUid)) return EMPTY_MEMBER_VITALS;
  try {
    const { vitals, prescOf, consultOf, modality } = await fetchRows(individualUid);
    const trend = vitals.filter(hasAnyVital);
    let thisVisit: VitalsRead | null = null;
    if (isUid(prescUid)) {
      // D-A: CONSULT_UID FIRST (99.6% populated), prescription_uid as the fallback (5.8%). Both
      // paths are kept: the old key still resolves the minority of rows that carry only it, so
      // this can only find MORE visits than before, never fewer.
      const consultUid = await consultUidForPresc(prescUid);
      if (consultUid) {
        const ci = consultOf.findIndex((c, i) => c === consultUid && hasAnyVital(vitals[i]));
        if (ci >= 0) thisVisit = vitals[ci];
      }
      if (!thisVisit) {
        const idx = prescOf.findIndex((p, i) => p === prescUid && hasAnyVital(vitals[i]));
        if (idx >= 0) thisVisit = vitals[idx];
      }
    }
    return { latest: thisVisit, trend, modality };
  } catch {
    // The soft-fail contract is absolute: this function never throws onto a clinical screen.
    return EMPTY_MEMBER_VITALS;
  }
}
