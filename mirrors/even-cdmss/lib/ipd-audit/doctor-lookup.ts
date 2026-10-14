/**
 * lib/ipd-audit/doctor-lookup.ts — treating-doctor attribution for IPD audits, joined from db13 at
 * READ TIME and never stored (decisions §1.10 / §1.14).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SCHEMA IS VALIDATED — DO NOT INFER, DO NOT SUBSTITUTE (PRD §2.11).
 *
 *   kx_discharge_summary_records
 *     ipd_no                      ← THE JOIN KEY. Matches ipd_discharge_audits.ip_uid exactly.
 *     treating_doctor_team        ← the treating doctor's name
 *     treating_doctor_speciality  ← matches ipd_discharge_audits.speciality exactly
 *     admitting_doctor_team       ← fallback when treating is null
 *     discharge_date_time         ← recency tie-break
 *
 * THREE PLAUSIBLE ALTERNATIVES ARE WRONG and are recorded as rejected in §2.11. Do NOT "fix" the
 * join to any of them:
 *   · kx_ip_admissions — `uid` is a UUID and does not match ip_uid; admission_request_no is null
 *   · accounts-members-miscellaneous_documents.additional_metadata__doctor_uid — one distinct
 *     value across 119 of 1,893 documents; it is a service account, not the clinician
 *   · kx_discharged_completed_patients.uid — does not match ip_uid
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ MULTIPLE ROWS PER ipd_no ARE NORMAL AND CAN NAME DIFFERENT DOCTORS. `IPNO-229` returns both
 * `Dr Darshana R` (Internal Medicine) and `Dr Vinod Kumar` (Orthopedics). NEVER take the first row.
 * The five-step resolution in §6.3 is implemented in `resolveDoctor` below and is unit-tested on
 * exactly that case.
 *
 * FAIL-SOFT IS MANDATORY (§6.3, §8.8). On any error, timeout or no-match this returns
 * `Unattributed` and sets `unavailable`, so the caller renders a single non-blocking notice and
 * every other column keeps working. It never throws, never 500s, and never guesses a name.
 */

import { metabaseQuery } from '../metabase';

/** ip_uid shapes seen live: `IP-1250`, `IPNO-229`, `ER-511`. Mirrors lib/ipd-audit/db13.ts. */
const isIpUid = (s: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(s);
const esc = (s: string) => s.replace(/'/g, "''");

export const UNATTRIBUTED = 'Unattributed';

/** One db13 discharge-summary record, reduced to the four fields attribution needs. */
export interface DoctorRecord {
  ipdNo: string;
  treatingDoctor: string | null;
  treatingSpeciality: string | null;
  admittingDoctor: string | null;
  dischargeDateTime: string | null;
}

export interface DoctorAttribution {
  /** The resolved name, or `Unattributed`. Never null, never a guess. */
  name: string;
  /** True when the audit's speciality was null, so recency alone picked the row (§6.3 step 3). */
  specialityUnconfirmed: boolean;
  /** True when the name came from admitting_doctor_team (§6.3 step 4). */
  fromAdmitting: boolean;
}

export const UNATTRIBUTED_RESULT: DoctorAttribution = { name: UNATTRIBUTED, specialityUnconfirmed: false, fromAdmitting: false };

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Most recent first; rows with no timestamp sort last, deterministically. */
function byRecencyDesc(a: DoctorRecord, b: DoctorRecord): number {
  const ta = a.dischargeDateTime ? Date.parse(a.dischargeDateTime) : NaN;
  const tb = b.dischargeDateTime ? Date.parse(b.dischargeDateTime) : NaN;
  const va = Number.isFinite(ta), vb = Number.isFinite(tb);
  if (va && vb) return tb - ta;
  if (va) return -1;
  if (vb) return 1;
  return 0;
}

/**
 * THE FIVE-STEP RESOLUTION (§6.3, §8.10). PURE — no I/O, so it is unit-testable and the
 * `IPNO-229` two-doctor case is asserted directly.
 *
 *   1. match on BOTH ipd_no AND treating_doctor_speciality = the audit's speciality
 *   2. still ambiguous → most recent discharge_date_time
 *   3. audit speciality null (4 of 345) → most recent row, mark `specialityUnconfirmed`
 *   4. treating_doctor_team null → fall back to admitting_doctor_team
 *   5. nothing matches → Unattributed
 *
 * Note the ORDER of 1 and 3: a null audit speciality cannot match on speciality, so it skips
 * straight to recency. Filtering first and falling back to recency (rather than the reverse) is
 * what stops `IPNO-229`'s Internal Medicine audit resolving to the Orthopedics doctor.
 */
export function resolveDoctor(rows: DoctorRecord[], auditSpeciality: string | null): DoctorAttribution {
  const all = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!all.length) return UNATTRIBUTED_RESULT;

  const spec = str(auditSpeciality);
  let candidates: DoctorRecord[];
  let specialityUnconfirmed = false;

  if (spec) {
    // Step 1 — speciality-matched. Compared case-insensitively and trimmed; §2.11 records that the
    // two columns match exactly, so this only absorbs incidental whitespace/casing.
    candidates = all.filter((r) => (r.treatingSpeciality ?? '').trim().toLowerCase() === spec.toLowerCase());
    if (!candidates.length) {
      // No speciality match at all. Do NOT silently pick another speciality's doctor — that is the
      // exact failure §8.10 forbids. Fall back to recency, but mark it unconfirmed so the surface
      // says so rather than presenting a confident wrong name.
      candidates = all;
      specialityUnconfirmed = true;
    }
  } else {
    // Step 3 — the audit has no speciality (4 of 345).
    candidates = all;
    specialityUnconfirmed = true;
  }

  // Step 2 — most recent wins among whatever survived.
  const best = [...candidates].sort(byRecencyDesc)[0];
  if (!best) return UNATTRIBUTED_RESULT;

  // Step 4 — treating, else admitting.
  const treating = str(best.treatingDoctor);
  if (treating) return { name: treating, specialityUnconfirmed, fromAdmitting: false };
  const admitting = str(best.admittingDoctor);
  if (admitting) return { name: admitting, specialityUnconfirmed, fromAdmitting: true };

  // Step 5.
  return UNATTRIBUTED_RESULT;
}

export interface DoctorLookupResult {
  /** ip_uid → attribution. Only ids that resolved appear; the caller defaults the rest. */
  byIpUid: Record<string, DoctorAttribution>;
  /** True when db13 could not be reached — the caller shows ONE non-blocking notice. */
  unavailable: boolean;
}

/**
 * BATCHED — one Metabase call per page of results, NEVER one per row (§6.3).
 *
 * ⚠️ ADAPTATION, FLAGGED: the PRD writes the join as `WHERE ipd_no = ANY($1)`. `metabaseQuery`
 * (lib/metabase.ts) posts a NATIVE query string to Metabase's /api/dataset — it takes no bound
 * parameters, so `$1` cannot be supplied. The query is therefore an escaped `IN (…)` list, exactly
 * as lib/ipd-audit/db13.ts `namesForIpUids` already queries THIS SAME TABLE by THIS SAME KEY. The
 * table, the join column and the selected columns are unchanged from §2.11.
 *
 * Inputs are filtered through `isIpUid` and single-quote-escaped before interpolation, so a value
 * that is not an ip_uid never reaches the query.
 */
export async function fetchDoctorsForAudits(
  audits: { ipUid: string | null | undefined; speciality: string | null | undefined }[],
): Promise<DoctorLookupResult> {
  const ids = Array.from(new Set(
    (Array.isArray(audits) ? audits : [])
      .map((a) => String(a?.ipUid ?? '').trim())
      .filter((u) => u && isIpUid(u)),
  ));
  if (!ids.length) return { byIpUid: {}, unavailable: false };

  let rows: Record<string, unknown>[];
  try {
    const list = ids.map((u) => `'${esc(u)}'`).join(', ');
    rows = await metabaseQuery(
      `SELECT ipd_no, treating_doctor_team, treating_doctor_speciality,
              admitting_doctor_team, admitting_doctor_speciality, discharge_date_time
         FROM kx_discharge_summary_records
        WHERE ipd_no IN (${list})`,
    );
  } catch {
    // FAIL-SOFT. Everything renders as Unattributed with one notice; no column is lost.
    return { byIpUid: {}, unavailable: true };
  }

  // Group by ipd_no, THEN resolve per audit — because two audits can share an ipd_no with
  // different specialities and must resolve to different doctors.
  const byId = new Map<string, DoctorRecord[]>();
  for (const r of rows) {
    const key = str(r.ipd_no);
    if (!key) continue;
    const rec: DoctorRecord = {
      ipdNo: key,
      treatingDoctor: str(r.treating_doctor_team),
      treatingSpeciality: str(r.treating_doctor_speciality),
      admittingDoctor: str(r.admitting_doctor_team),
      dischargeDateTime: str(r.discharge_date_time),
    };
    const bucket = byId.get(key);
    if (bucket) bucket.push(rec); else byId.set(key, [rec]);
  }

  const byIpUid: Record<string, DoctorAttribution> = {};
  for (const a of audits) {
    const uid = String(a?.ipUid ?? '').trim();
    if (!uid || !isIpUid(uid)) continue;
    const recs = byId.get(uid);
    byIpUid[uid] = recs?.length ? resolveDoctor(recs, a?.speciality ?? null) : UNATTRIBUTED_RESULT;
  }
  return { byIpUid, unavailable: false };
}

/** Group already-attributed audit rows by doctor, for the `Group by doctor` view (§6.3). */
export interface DoctorGroup {
  name: string;
  n: number;
  meanCompleteness: number | null;
  bands: Record<string, number>;
  auditIds: string[];
  specialityUnconfirmed: boolean;
}

export function groupByDoctor(
  rows: { id: string; ipUid: string | null | undefined; completeness: number | null | undefined; band: string | null | undefined }[],
  byIpUid: Record<string, DoctorAttribution>,
): DoctorGroup[] {
  const map = new Map<string, DoctorGroup & { _sum: number; _n: number }>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const attr = byIpUid[String(r?.ipUid ?? '')] ?? UNATTRIBUTED_RESULT;
    let g = map.get(attr.name);
    if (!g) {
      g = { name: attr.name, n: 0, meanCompleteness: null, bands: {}, auditIds: [], specialityUnconfirmed: attr.specialityUnconfirmed, _sum: 0, _n: 0 };
      map.set(attr.name, g);
    }
    g.n += 1;
    g.auditIds.push(String(r.id));
    const band = r.band == null ? null : String(r.band);
    if (band) g.bands[band] = (g.bands[band] ?? 0) + 1;
    const c = r.completeness == null ? null : Number(r.completeness);
    if (c != null && Number.isFinite(c)) { g._sum += c; g._n += 1; }
    // A group is only "unconfirmed" if EVERY member is — one confirmed attribution settles it.
    if (!attr.specialityUnconfirmed) g.specialityUnconfirmed = false;
  }
  return [...map.values()]
    .map((g) => ({
      name: g.name, n: g.n,
      meanCompleteness: g._n ? Math.round(g._sum / g._n) : null,
      bands: g.bands, auditIds: g.auditIds, specialityUnconfirmed: g.specialityUnconfirmed,
    }))
    // Most discharges first; Unattributed always last so it never leads the view.
    .sort((a, b) => (a.name === UNATTRIBUTED ? 1 : 0) - (b.name === UNATTRIBUTED ? 1 : 0) || b.n - a.n || a.name.localeCompare(b.name));
}

/** The single non-blocking notice, verbatim per §6.3. */
export const DOCTOR_UNAVAILABLE_NOTICE = 'Doctor names are temporarily unavailable';
