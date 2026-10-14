/**
 * Staff-only gate for the audit-findings routes (Round 2 / F3).
 *
 * The middleware already requires the `epi_session` cookie for every /api/* path outside /portal, and
 * a doctor's portal session is a different cookie (`epi_physician_session`), so a doctor never
 * reaches these handlers. The handlers do not rely on that: each one calls `requireStaff`, which
 * re-reads the staff session and refuses everything else, so the rule survives a middleware change
 * and a direct handler call in a test.
 *
 *   view    super_admin, Site Medical Head or Site Governance Officer. Reads the worklist, threads.
 *   manage  super_admin or Site Medical Head. Rules on a thread; confirms or rejects doctor links.
 *
 * 401 = no usable staff session (including a physician token presented as a staff cookie, or an
 *       account that is no longer active).
 * 403 = a real staff session without the role.
 *
 * The role is NOT taken from the 7-day cookie: it is re-read from the database on every request
 * (src/lib/staff-live.ts), so a revoked flag or a deactivated account stops working at once. If the
 * database cannot confirm the role the request is refused (401), never allowed. `scope` says where a
 * manage-level user may act: a Site Medical Head only for physicians at their own hospital(s).
 */

import { NextResponse } from "next/server";
import { getCurrentUser, type JWTPayload } from "@/lib/auth";
import { loadLiveStaff, scopeOf, type LiveStaff, type StaffScope } from "@/lib/staff-live";

export type StaffLevel = "view" | "manage";

export type StaffCheck = { ok: true; user: JWTPayload; live: LiveStaff; scope: StaffScope } | { ok: false; response: NextResponse };

/** PURE. May this session do things at `level`? */
export function staffAllows(user: Pick<JWTPayload, "is_super_admin" | "is_sgc_member" | "is_site_medical_head">, level: StaffLevel): boolean {
  if (user.is_super_admin === true || user.is_site_medical_head === true) return true;
  return level === "view" && user.is_sgc_member === true;
}

export async function requireStaff(level: StaffLevel): Promise<StaffCheck> {
  const user = await getCurrentUser();
  const kind = (user as unknown as { kind?: unknown } | null)?.kind;
  if (!user || user.status !== "active" || kind === "physician") {
    return { ok: false, response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  // The cookie only says who this is. What they may do is what the database says now.
  const live = await loadLiveStaff(user.profileId);
  if (!live || live.status !== "active") {
    return { ok: false, response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  if (!staffAllows(live, level)) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }) };
  }
  return {
    ok: true,
    user: {
      ...user,
      status: live.status,
      is_super_admin: live.is_super_admin,
      is_site_medical_head: live.is_site_medical_head,
      is_sgc_member: live.is_sgc_member,
    },
    live,
    scope: scopeOf(live),
  };
}
