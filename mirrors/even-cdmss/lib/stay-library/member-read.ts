/**
 * lib/stay-library/member-read.ts — read one MEMBER's stay libraries
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P4 support for §6.4 / O12).
 *
 * WHY THIS LIVES IN THE LIBRARY AND NOT IN THE SPINE. The P4 fold needs, for one `individual_uid`,
 * the stays that individual had and the ClinicalState documents on each. That is two db13 reads and
 * one Neon read — none of which the frozen spine should be doing itself, and one of which
 * (the admission header) the IPD audit module already owns. Architecture rule 6 forbids
 * `lib/member-state/**` from value-importing `lib/ipd-audit/**`, and rightly: the spine must not
 * couple to the audit engine. So the layering is spine → stay-library → db13, and this file is the
 * library's member-shaped door. Flagged in the P4 report for the orchestrator's judgement.
 *
 * PHI. The UHID is read here and RETURNED IN MEMORY so the caller's identity hop can verify against
 * it. It is never written to Neon, never stored on a ClinicalState, and never reaches a prompt.
 *
 * FAIL-CLOSED. Every hop returns empty on any fault. An empty result means "we could not establish
 * this member's stays", which folds nothing — never "this member had no stays", and never a guess.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live DB. Both db13 queries are listed verbatim in the report.
 */
import { metabaseQuery } from '../metabase';
import { CLINICAL_STATE_VERSION, type ClinicalState } from '../clinical-state/schema';
import { readStayLibrary } from './store';
import type { StayDocStatus } from './core';

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
/** The uid grammar db13 uses for `individuals.uid` — same guard the CCB fetch path applies. */
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
/** The UHID grammar every db13 reader in this repo shares. */
const isUhid = (u: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(u);
const esc = (v: string) => v.replace(/'/g, "''");

/** One stay of one member, with the documents the library holds for it. */
export interface MemberStayRead {
  /** The IP encounter (ipd_no) — opaque, and the key `clinical_states.encounter_ref` carries. */
  encounterRef: string;
  /** The stay's date, IST, as db13 stated it. Discharge date preferred; admit date as fallback. */
  date: string;
  /** Read-time only, for the caller's identity re-verification. NEVER persisted. */
  uhids: string[];
  memberUid: string | null;
  documents: Array<{ status: StayDocStatus; state: ClinicalState }>;
}

/**
 * individual_uid → its kx UHID. The bridge `lib/ccb-fetch-core.ts` already defines and the CCB rail
 * already uses; restated here rather than imported so this module keeps one dependency direction.
 *
 * ⚠️ INFERRED: `SELECT kx_uhid FROM individuals WHERE uid = '<uid>' LIMIT 1`
 */
export async function uhidForIndividual(individualUid: string): Promise<string | null> {
  if (!individualUid || !isUid(individualUid)) return null;
  try {
    const rows = await metabaseQuery(`SELECT kx_uhid FROM individuals WHERE uid = '${esc(individualUid)}' LIMIT 1`);
    const u = s(rows[0]?.kx_uhid);
    return u && isUhid(u) ? u : null;
  } catch {
    return null;
  }
}

/**
 * A UHID's completed IP stays — the ipd_no and the dates. Same table and same columns
 * `fetchIpdAdmissionHeader` reads, in a by-UHID shape rather than by-ipd_no.
 *
 * ⚠️ INFERRED:
 *   SELECT DISTINCT ON (ipd_no) ipd_no, uhid,
 *          to_char(discharge_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS discharge_date,
 *          to_char(admission_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS admit_date
 *     FROM kx_discharge_summary_records
 *    WHERE uhid = '<uhid>'
 *    ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST
 *    LIMIT 100
 */
export async function staysForUhid(uhid: string): Promise<Array<{ encounterRef: string; date: string; uhid: string | null }>> {
  if (!uhid || !isUhid(uhid)) return [];
  try {
    const rows = await metabaseQuery(
      `SELECT DISTINCT ON (ipd_no) ipd_no, uhid,
              to_char(discharge_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS discharge_date,
              to_char(admission_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS admit_date
         FROM kx_discharge_summary_records
        WHERE uhid = '${esc(uhid)}'
        ORDER BY ipd_no, (status='Final') DESC, discharge_date_time DESC NULLS LAST
        LIMIT 100`);
    return rows
      .map((r) => ({
        encounterRef: String(r.ipd_no ?? ''),
        // A stay with NO date is dropped below: the spine orders and cuts by date, and an undated
        // encounter would sort as the oldest thing a member ever had.
        date: s(r.discharge_date) ?? s(r.admit_date) ?? '',
        uhid: s(r.uhid),
      }))
      .filter((x) => x.encounterRef && x.date);
  } catch {
    return [];
  }
}

/**
 * Everything the fold needs for one member: each stay, its UHIDs (for the caller's identity
 * re-verification) and its ClinicalState documents.
 *
 * Fail-closed at every hop. No UHID for the individual, no stays for the UHID, or an unreadable
 * library all yield [] — which folds nothing.
 */
export async function readMemberStayLibraries(
  individualUid: string,
  schemaVersion: string = CLINICAL_STATE_VERSION,
): Promise<MemberStayRead[]> {
  const uhid = await uhidForIndividual(individualUid);
  if (!uhid) return [];
  const stays = await staysForUhid(uhid);
  if (!stays.length) return [];

  const out: MemberStayRead[] = [];
  for (const stay of stays) {
    const lib = await readStayLibrary(stay.encounterRef, schemaVersion);
    // A stay with no library rows has nothing to fold. It is skipped rather than folded empty:
    // an `ipd` encounter for a stay we never built would put a bare reference on the spine with no
    // evidence behind it.
    if (!lib.documents.length) continue;
    out.push({
      encounterRef: stay.encounterRef,
      date: stay.date,
      uhids: [stay.uhid, uhid].filter((u): u is string => !!u),
      memberUid: lib.documents.find((d) => d.memberUid)?.memberUid ?? null,
      documents: lib.documents.map((d) => ({ status: d.status, state: d.state })),
    });
  }
  return out;
}
