import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/physicians/[id]/oppe
 * List all OPPE rows for this physician (across all hospitals).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT
      o.id::text AS id,
      o.physician_id::text AS physician_id,
      o.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      o.period_start::text AS period_start,
      o.period_end::text AS period_end,
      o.due_at,
      o.status,
      o.completed_at,
      o.decision_notes,
      o.reviewer_id::text AS reviewer_id,
      pp.email AS reviewer_email,
      pp.full_name AS reviewer_name,
      o.created_at
    FROM oppe_reviews o
    JOIN hospitals h ON h.id = o.hospital_id
    LEFT JOIN profiles pp ON pp.id = o.reviewer_id
    WHERE o.physician_id = ${id}::uuid
    ORDER BY
      (CASE WHEN o.status IN ('pending','in_review') THEN 0 ELSE 1 END),
      o.due_at ASC,
      o.created_at DESC
  `) as Array<Record<string, unknown>>;

  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}
