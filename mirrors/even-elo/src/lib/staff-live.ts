/**
 * src/lib/staff-live.ts — a staff member's CURRENT role, read from the database (Round 2 / F3).
 *
 * The session cookie is a 7-day JWT whose role flags were true at login. A governance ruling, a
 * doctor-mapping confirm and the /api/admin ops routes must not trust those claims: someone whose
 * super-admin or Site Medical Head flag was revoked, or whose account was deactivated, would keep
 * acting until the token expired. These helpers re-read the flags on every request.
 *
 * Also the site scope. A Site Medical Head acts only for physicians engaged at a hospital they head;
 * a super admin acts everywhere.
 */

import { sql } from "@/lib/db";

export interface LiveStaff {
  status: string;
  is_super_admin: boolean;
  is_site_medical_head: boolean;
  is_sgc_member: boolean;
  /** Hospitals this person is Site Medical Head of (profile_hospital_roles). */
  smh_hospital_ids: string[];
}

/** Where a staff member may act on physicians: everywhere, or only at these hospitals. */
export type StaffScope = { all: true } | { all: false; hospitalIds: string[] };

interface LiveRow {
  status: string | null;
  is_super_admin: boolean | null;
  is_site_medical_head: boolean | null;
  is_sgc_member: boolean | null;
  smh_hospital_ids: string[] | null;
}

/**
 * The profile's current status and role flags, or null when the profile is gone or the read failed.
 * Callers treat null as "refuse" (fail closed): a database that cannot confirm a role does not grant it.
 */
export async function loadLiveStaff(profileId: string): Promise<LiveStaff | null> {
  if (!profileId) return null;
  try {
    const rows = (await sql`
      SELECT p.status, p.is_super_admin, p.is_site_medical_head, p.is_sgc_member,
             ARRAY(
               SELECT r.hospital_id::text FROM profile_hospital_roles r
               WHERE r.profile_id = p.id AND r.role = 'site_medical_head'
             ) AS smh_hospital_ids
      FROM profiles_with_roles p
      WHERE p.id = ${profileId}::uuid
      LIMIT 1`) as unknown as LiveRow[];
    const r = Array.isArray(rows) ? rows[0] : undefined;
    if (!r) return null;
    return {
      status: String(r.status ?? ""),
      is_super_admin: r.is_super_admin === true,
      is_site_medical_head: r.is_site_medical_head === true,
      is_sgc_member: r.is_sgc_member === true,
      smh_hospital_ids: Array.isArray(r.smh_hospital_ids) ? r.smh_hospital_ids.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** PURE. A super admin acts everywhere; anyone else only at the hospitals they head. */
export function scopeOf(live: Pick<LiveStaff, "is_super_admin" | "smh_hospital_ids">): StaffScope {
  if (live.is_super_admin) return { all: true };
  return { all: false, hospitalIds: live.smh_hospital_ids };
}

/**
 * Which of these physicians the scope covers. A physician is covered when they have a non-terminated
 * engagement at one of the scope's hospitals. Super admin: all of them, no query. Any read failure:
 * none (fail closed).
 */
export async function physiciansInScope(scope: StaffScope, physicianIds: readonly string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(physicianIds.filter(Boolean)));
  if (ids.length === 0) return new Set();
  if (scope.all) return new Set(ids);
  if (scope.hospitalIds.length === 0) return new Set();
  try {
    const rows = (await sql`
      SELECT DISTINCT physician_id::text AS id
      FROM physician_engagements
      WHERE physician_id = ANY(${ids}::uuid[])
        AND hospital_id = ANY(${scope.hospitalIds}::uuid[])
        AND status <> 'terminated'`) as unknown as Array<{ id: string }>;
    return new Set((Array.isArray(rows) ? rows : []).map((r) => r.id));
  } catch {
    return new Set();
  }
}

export async function physicianInScope(scope: StaffScope, physicianId: string | null | undefined): Promise<boolean> {
  if (!physicianId) return false;
  return (await physiciansInScope(scope, [physicianId])).has(physicianId);
}

/** May this scope act on this physician? A super admin may even when the physician is unlinked; a site head may not. */
export async function canActOnPhysician(scope: StaffScope, physicianId: string | null | undefined): Promise<boolean> {
  if (scope.all) return true;
  return physicianInScope(scope, physicianId);
}
