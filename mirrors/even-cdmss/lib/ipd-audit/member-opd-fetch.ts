// lib/ipd-audit/member-opd-fetch.ts — MemberState admission adapter (#5) SL3: the read-time OPD
// fetch backing the medication-reconciliation view.
//
// CONSUMER side (mirrors episode-opd-adapter's PHI boundary). The patient uhid (PHI, from the kx
// admission header) is a TRANSIENT JOIN KEY ONLY — it resolves the OPD individual_uid via the
// maintained individuals.kx_uhid bridge, then the pre-admission prescription + lab rows are read
// with ONLY clinical / opaque columns (medications, dx codes, labs, the prescription uid — never
// name / mobile / dob). The rows land in the assembleEvidence input shape (which is itself
// identifier-free by construction — assemble-core copies only clinical content + opaque refs).
//
// NEVER THROWS. Any miss — no uhid, no member match (the ~50% unlinked tail), a db outage — returns
// linked:false with empty rows, so the surface shows the honest admission-list-only banner rather
// than a fabricated clean reconciliation.

import { metabaseQuery } from '../metabase';

const esc = (s: string) => String(s).replace(/'/g, "''");

export interface MemberOpdRows {
  linked: boolean;
  memberRef: string;                       // opaque individual_uid (identifier-free) or ''
  prescriptionRows: Record<string, unknown>[];
  labRows: Record<string, unknown>[];
}

const EMPTY: MemberOpdRows = { linked: false, memberRef: '', prescriptionRows: [], labRows: [] };

/**
 * Resolve a kx uhid → OPD individual_uid and fetch the PRE-ADMISSION prescription + lab rows (the
 * reconciliation baseline). `admitDate` (YYYY-MM-DD) bounds the OPD history to encounters before the
 * admission; when null, the full OPD history is used. Never throws.
 */
export async function fetchMemberOpdRows(uhid: string | null, admitDate: string | null): Promise<MemberOpdRows> {
  try {
    if (!uhid) return EMPTY;
    const iuRows = await metabaseQuery(`SELECT uid FROM individuals WHERE kx_uhid = '${esc(uhid)}' LIMIT 1`);
    const iu = iuRows[0]?.uid ? String(iuRows[0].uid) : null;
    if (!iu) return EMPTY;                  // unlinked tail — no OPD footprint at Even

    const before = admitDate ? `AND timestamp::date < '${esc(admitDate)}'` : '';
    const prescriptionRows = (await metabaseQuery(
      `SELECT uid, patient_details__allergies, diagnosis_icd_codes, impression_icd_codes,
              to_jsonb(medications) AS medications,
              to_char(timestamp AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS visit_date
         FROM "individuals-prescriptions"
        WHERE _parent_id = '${esc(iu)}' AND is_draft = false ${before}
        ORDER BY timestamp DESC
        LIMIT 200`,
    )) as Record<string, unknown>[];

    const labRows = (await metabaseQuery(
      `SELECT t.value, t.investigation_name, t.investigation_unit, t.investigation_is_abnormal,
              t.booking_id, t.test_result_uid, d.test_date
         FROM test_values_view t
         JOIN test_digital_values_view d ON d.booking_id = t.booking_id AND d.test_result_uid = t.test_result_uid
        WHERE t._parent_id = '${esc(iu)}'
        ORDER BY d.test_date DESC
        LIMIT 300`,
    )) as Record<string, unknown>[];

    return { linked: true, memberRef: iu, prescriptionRows, labRows };
  } catch (e) {
    console.warn('[med-rec] OPD fetch failed (non-fatal, admission-list-only):', String((e as Error).message).slice(0, 160));
    return EMPTY;
  }
}
