import { cookies } from "next/headers";
import { neon } from "@neondatabase/serverless";

export const HOSPITAL_FILTER_COOKIE = "epi_hospital_filter";
export const HOSPITAL_FILTER_DEFAULT = "all";

/**
 * Read the current hospital filter from the cookie. Returns "all" if unset.
 *
 * Valid values: "all" OR one of the 4-letter hospital codes (EHRC/EHBR/EHIN/EHBO).
 * Caller is responsible for validating the code against the actual hospitals
 * catalogue if needed (we don't fail open here — unknown codes resolve to "all").
 */
export async function getHospitalFilter(): Promise<string> {
  const store = await cookies();
  const c = store.get(HOSPITAL_FILTER_COOKIE);
  if (!c?.value) return HOSPITAL_FILTER_DEFAULT;
  const v = String(c.value).trim().toUpperCase();
  if (v === "ALL") return "all";
  if (/^[A-Z]{2,8}$/.test(v)) return v;
  return HOSPITAL_FILTER_DEFAULT;
}

/**
 * Resolve the filter cookie to a hospital_id (uuid string) for SQL WHERE clauses.
 * Returns null when filter is "all" — caller should branch on null to skip the WHERE.
 */
export async function getHospitalFilterId(): Promise<string | null> {
  const code = await getHospitalFilter();
  if (code === "all") return null;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = neon(url);
  const rows = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
