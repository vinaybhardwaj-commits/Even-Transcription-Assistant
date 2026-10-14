import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

interface PublicPhysicianRow {
  id: string;
  full_name: string;
  primary_specialty: string | null;
  hospitals_active: string | null;
}

/**
 * GET /api/public/physicians?q=&hospital_code=
 *
 * UNAUTHENTICATED — backs the public /report doctor picker. Must be
 * allowlisted in middleware PUBLIC_API_ROUTES.
 *
 * Deliberately minimal: returns ONLY id + name + specialty + active-hospital
 * codes, and ONLY for physicians who are currently active AND hold at least
 * one active engagement. No email, phone, registration, or status leaks.
 * Requires a >= 2 char query and caps at 20 rows so the form can't be used to
 * dump the whole roster in one shot.
 */
export async function GET(req: NextRequest) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  }
  const sql = neon(url);
  const params = req.nextUrl.searchParams;
  const q = (params.get("q") ?? "").trim();
  let hospitalCode = (params.get("hospital_code") ?? "").trim();
  if (hospitalCode.toLowerCase() === "all") hospitalCode = "";

  if (q.length < 2) {
    return NextResponse.json({ ok: true, rows: [], total: 0 }, { headers: NO_STORE });
  }

  const rows = (await sql`
    WITH eng AS (
      SELECT
        e.physician_id,
        STRING_AGG(DISTINCT h.code, ', ' ORDER BY h.code) AS hospitals_active
      FROM physician_engagements e
      JOIN hospitals h ON h.id = e.hospital_id
      WHERE e.status = 'active'
      GROUP BY e.physician_id
    )
    SELECT
      p.id::text AS id,
      p.full_name,
      p.primary_specialty,
      eng.hospitals_active
    FROM physicians p
    JOIN eng ON eng.physician_id = p.id
    WHERE p.current_status = 'active'
      AND p.full_name ILIKE ${'%' + q + '%'}
      AND (${hospitalCode} = '' OR ${hospitalCode} = ANY(STRING_TO_ARRAY(eng.hospitals_active, ', ')))
    ORDER BY p.full_name ASC
    LIMIT 20
  `) as PublicPhysicianRow[];

  return NextResponse.json({ ok: true, rows, total: rows.length }, { headers: NO_STORE });
}
