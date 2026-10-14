import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/oppe/[id] — full OPPE detail including packet_jsonb.
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
      p.full_name AS physician_name,
      p.primary_specialty,
      o.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      h.name AS hospital_name,
      o.period_start::text AS period_start,
      o.period_end::text AS period_end,
      o.due_at,
      o.status,
      o.packet_jsonb,
      o.reviewer_id::text AS reviewer_id,
      pp.email AS reviewer_email,
      pp.full_name AS reviewer_name,
      o.decision_notes,
      o.completed_at,
      o.created_at
    FROM oppe_reviews o
    JOIN physicians p ON p.id = o.physician_id
    JOIN hospitals  h ON h.id = o.hospital_id
    LEFT JOIN profiles pp ON pp.id = o.reviewer_id
    WHERE o.id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  return NextResponse.json({ ok: true, oppe: rows[0] }, { headers: NO_STORE });
}
