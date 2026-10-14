/**
 * Reader catalog_identity — CATALOG-5 (14 Oct 2026): the identity and prescription columns of encounter_catalog (migration 0168), joined to the R2 catalog rows by consult_uid.
 *
 * The R2 catalog stays the row source; this table is read ONLY for doctor_name, patient_name, individual_uid, prescription_uid, presc_state, whether a prescription is stored, and (on request) the stored
 * `prescription` jsonb. These are PHI (V's Encounter Explorer ruling, 14 Oct: internal admins only, no PHI removal): the caller returns them only behind include_identity. Nothing here writes, logs a value, or throws.
 * At most 500 uids per query; the caller chunks. A missing table or any SQL error is {status:"error", code} (the code is a SQLSTATE or a fixed word, never a value).
 */
import { sql } from "@/lib/db";

export const IDENTITY_CHUNK = 500;
/** The id class migration 0168 enforces on individual_uid and prescription_uid. */
export const IDENTITY_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

export type IdentityRow = {
  doctor_name: string | null; patient_name: string | null; individual_uid: string | null; prescription_uid: string | null; presc_state: string | null;
  has_prescription: boolean; prescription: unknown;
};
export type IdentityResult = { status: "ok"; rows: Map<string, IdentityRow> } | { status: "error"; code: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function identityFor(uids: readonly string[], opts: { withPrescription?: boolean } = {}): Promise<IdentityResult> {
  if (uids.length > IDENTITY_CHUNK) return { status: "error", code: "too_many_uids" };
  const rows = new Map<string, IdentityRow>();
  if (uids.length === 0) return { status: "ok", rows };
  const withRx = opts.withPrescription === true;
  try {
    const got = (await sql`
      SELECT consult_uid, doctor_name, patient_name, individual_uid, prescription_uid, presc_state,
             (prescription IS NOT NULL) AS has_prescription,
             CASE WHEN ${withRx}::boolean THEN prescription END AS prescription
        FROM encounter_catalog
       WHERE consult_uid = ANY(${[...uids]}::text[])
    `) as Array<Record<string, unknown>>;
    for (const r of got) {
      if (typeof r.consult_uid !== "string") continue;
      rows.set(r.consult_uid, {
        doctor_name: str(r.doctor_name), patient_name: str(r.patient_name), individual_uid: str(r.individual_uid), prescription_uid: str(r.prescription_uid), presc_state: str(r.presc_state),
        has_prescription: r.has_prescription === true, prescription: withRx ? (r.prescription ?? null) : undefined,
      });
    }
    return { status: "ok", rows };
  } catch (e) {
    const c = (e as { code?: unknown })?.code;
    return { status: "error", code: typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? `db_error:${c}` : "read_failed" };
  }
}

/** The Pulse link of a prescription, only when both ids fit the id class; else null. */
export function pulseUrl(prescriptionUid: string | null, individualUid: string | null): string | null {
  if (!prescriptionUid || !individualUid || !IDENTITY_ID.test(prescriptionUid) || !IDENTITY_ID.test(individualUid)) return null;
  return `https://pulse.even.in/prescription?prescription_uid=${encodeURIComponent(prescriptionUid)}&individual_uid=${encodeURIComponent(individualUid)}`;
}

/** Does the joined row hold any identity column at all? */
export const hasAnyIdentity = (r: IdentityRow): boolean => r.doctor_name !== null || r.patient_name !== null || r.individual_uid !== null || r.prescription_uid !== null || r.presc_state !== null;

/** The identity block returned behind include_identity. */
export const identityView = (r: IdentityRow) => ({
  doctor_name: r.doctor_name, patient_name: r.patient_name, individual_uid: r.individual_uid, prescription_uid: r.prescription_uid, presc_state: r.presc_state,
  pulse_url: pulseUrl(r.prescription_uid, r.individual_uid),
});

// --- C5: the id filters run in SQL, bounded by the search window ------------------------------------------------------------------------------------
export const IDENTITY_MATCH_CAP = 2000;
export type MatchResult = { status: "ok"; uids: Set<string> } | { status: "too_many_matches" } | { status: "error"; code: string };

/** The consult_uids whose joined identity matches the given ids inside [from, to] (IST dates). At most 2000; one more than that is too_many_matches. Never throws. */
export async function consultsByIdentity(f: { individualUid: string | null; prescriptionUid: string | null; from: string; to: string }): Promise<MatchResult> {
  try {
    const cap = IDENTITY_MATCH_CAP + 1;
    const got = (f.individualUid !== null && f.prescriptionUid !== null
      ? await sql`
          SELECT consult_uid FROM encounter_catalog
           WHERE individual_uid = ${f.individualUid}::text AND prescription_uid = ${f.prescriptionUid}::text AND ist_date BETWEEN ${f.from}::date AND ${f.to}::date
           LIMIT ${cap}::int`
      : f.individualUid !== null
        ? await sql`
          SELECT consult_uid FROM encounter_catalog
           WHERE individual_uid = ${f.individualUid}::text AND ist_date BETWEEN ${f.from}::date AND ${f.to}::date
           LIMIT ${cap}::int`
        : await sql`
          SELECT consult_uid FROM encounter_catalog
           WHERE prescription_uid = ${f.prescriptionUid}::text AND ist_date BETWEEN ${f.from}::date AND ${f.to}::date
           LIMIT ${cap}::int`) as Array<Record<string, unknown>>;
    if (got.length > IDENTITY_MATCH_CAP) return { status: "too_many_matches" };
    return { status: "ok", uids: new Set(got.map((r) => String(r.consult_uid))) };
  } catch (e) {
    const c = (e as { code?: unknown })?.code;
    return { status: "error", code: typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? `db_error:${c}` : "read_failed" };
  }
}
