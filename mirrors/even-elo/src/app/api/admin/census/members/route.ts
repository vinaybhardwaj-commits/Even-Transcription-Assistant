import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { getHospitalFilterId } from "@/lib/hospital-filter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/admin/census/members — DR.3 drill-down.
 *   group=hospital&hospital_code=EHRC[&bucket=vc|staff]
 *   group=specialty&specialty=Orthopedics            (scoped by the global hospital filter)
 * Returns the named doctors in that census group → each links to /physicians/[id].
 */
export async function GET(req: NextRequest) {
  try { await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const sp = req.nextUrl.searchParams;
  const group = sp.get("group");
  const bucketRaw = (sp.get("bucket") ?? "").toLowerCase();
  const bucket = bucketRaw === "vc" || bucketRaw === "staff" ? bucketRaw : null;

  let members: Array<Record<string, unknown>> = [];

  if (group === "hospital") {
    const code = (sp.get("hospital_code") ?? "").trim();
    if (!code) return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
    const h = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${code} LIMIT 1`) as Array<{ id: string }>;
    if (h.length === 0) return NextResponse.json({ ok: true, members: [] }, { headers: NO_STORE });
    members = (await sql`
      WITH base AS (
        SELECT pe.physician_id, bool_or(pe.category = 'visiting_consultant') AS is_vc
        FROM physician_engagements pe JOIN physicians p ON p.id = pe.physician_id
        WHERE pe.status = 'active' AND p.current_status = 'active' AND pe.hospital_id = ${h[0].id}::uuid
        GROUP BY pe.physician_id)
      SELECT p.id::text AS id, p.full_name, p.primary_specialty,
             CASE WHEN base.is_vc THEN 'VC' ELSE 'Staff' END AS category
      FROM base JOIN physicians p ON p.id = base.physician_id
      WHERE (${bucket}::text IS NULL OR (CASE WHEN base.is_vc THEN 'vc' ELSE 'staff' END) = ${bucket})
      ORDER BY p.full_name ASC`) as Array<Record<string, unknown>>;
  } else if (group === "specialty") {
    const specialty = (sp.get("specialty") ?? "").trim();
    if (!specialty) return NextResponse.json({ ok: false, error: "specialty required" }, { status: 400, headers: NO_STORE });
    // Scope: an explicit hospital_code (accordion drill within one hospital) wins;
    // else fall back to the global hospital filter (Q-D).
    const code = (sp.get("hospital_code") ?? "").trim();
    let hid: string | null = null;
    if (code) {
      const h = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${code} LIMIT 1`) as Array<{ id: string }>;
      if (h.length === 0) return NextResponse.json({ ok: true, members: [] }, { headers: NO_STORE });
      hid = h[0].id;
    } else {
      hid = await getHospitalFilterId();
    }
    members = (await sql`
      WITH base AS (
        SELECT pe.physician_id, bool_or(pe.category = 'visiting_consultant') AS is_vc
        FROM physician_engagements pe JOIN physicians p ON p.id = pe.physician_id
        WHERE pe.status = 'active' AND p.current_status = 'active'
          AND (${hid}::uuid IS NULL OR pe.hospital_id = ${hid}::uuid)
        GROUP BY pe.physician_id)
      SELECT p.id::text AS id, p.full_name, p.primary_specialty,
             CASE WHEN base.is_vc THEN 'VC' ELSE 'Staff' END AS category
      FROM base JOIN physicians p ON p.id = base.physician_id
      WHERE COALESCE(NULLIF(trim(p.primary_specialty), ''), 'Unspecified') = ${specialty}
        AND (${bucket}::text IS NULL OR (CASE WHEN base.is_vc THEN 'vc' ELSE 'staff' END) = ${bucket})
      ORDER BY p.full_name ASC`) as Array<Record<string, unknown>>;
  } else {
    return NextResponse.json({ ok: false, error: "group must be hospital|specialty" }, { status: 400, headers: NO_STORE });
  }

  return NextResponse.json({ ok: true, members }, { headers: NO_STORE });
}
