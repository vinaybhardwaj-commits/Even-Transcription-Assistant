import { NextRequest, NextResponse } from "next/server";
import { getHospitalFilterId } from "@/lib/hospital-filter";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/admin/profiles?status=
 *
 * Returns the profile directory for super-admin views. Middleware enforces
 * super_admin on /api/admin/* paths.
 */
export async function GET(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const meSuper = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (meSuper.length === 0 || !meSuper[0].is_super_admin) return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });
  const params = req.nextUrl.searchParams;
  const status = (params.get("status") ?? "").trim();
  const hfid = await getHospitalFilterId();
  const hospital_id_filter = hfid ?? "";

  const rows = (await sql`
    SELECT
      p.id::text          AS id,
      p.email,
      p.full_name,
      p.status,
      p.is_super_admin,
      p.is_sgc_member,
      p.is_hr,
      p.is_site_medical_head,
      pos.position_name   AS position_label,
      h.code              AS hospital_code,
      p.last_login_at,
      p.created_at,
      p.requested_roles,
      (SELECT COUNT(*)::int FROM incidents i WHERE i.submitter_user_id = p.id)                                  AS submitted_count,
      (SELECT COUNT(*)::int FROM incidents i WHERE i.submitter_user_id = p.id AND i.status = 'retracted')        AS retracted_count
    FROM profiles_with_roles p
    JOIN positions pos ON pos.id = p.position_id
    JOIN hospitals h   ON h.id   = p.hospital_id
    WHERE (${status} = '' OR p.status = ${status})
      AND (${hospital_id_filter} = '' OR p.hospital_id = ${hospital_id_filter || '00000000-0000-0000-0000-000000000000'}::uuid OR EXISTS (SELECT 1 FROM profile_hospital_roles r WHERE r.profile_id = p.id AND r.hospital_id = ${hospital_id_filter || '00000000-0000-0000-0000-000000000000'}::uuid))
    ORDER BY
      CASE p.status WHEN 'pending_approval' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
      p.created_at DESC
  `) as Array<Record<string, unknown>>;

  // Aggregate counts for badge display
  const counts = (await sql`
    SELECT status, COUNT(*)::int AS n FROM profiles GROUP BY status
  `) as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const r of counts) byStatus[r.status] = r.n;

  return NextResponse.json(
    { ok: true, rows, counts: byStatus, total: rows.length },
    { headers: NO_STORE },
  );
}
