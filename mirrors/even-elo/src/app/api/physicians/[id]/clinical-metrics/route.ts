import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MetricRow {
  hospital_code: string;
  year: number;
  month: number;
  opd_count: number | null;
  ipd_admissions: number | null;
  ot_cases: number | null;
  revenue_inr: number | null;
  uploaded_at: string;
  uploaded_by_email: string | null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const months = parseInt(req.nextUrl.searchParams.get("months") ?? "24", 10);
  const lookback = Number.isFinite(months) ? Math.max(1, Math.min(120, months)) : 24;

  const rows = (await sql`
    SELECT
      h.code AS hospital_code,
      m.year::int AS year,
      m.month::int AS month,
      m.opd_count,
      m.ipd_admissions,
      m.ot_cases,
      m.revenue_inr::float AS revenue_inr,
      m.uploaded_at,
      p.email AS uploaded_by_email
    FROM clinical_metrics_monthly m
    JOIN hospitals h ON h.id = m.hospital_id
    LEFT JOIN profiles p ON p.id = m.uploaded_by
    WHERE m.physician_id = ${id}::uuid
      AND make_date(m.year::int, m.month::int, 1) >= (CURRENT_DATE - (${lookback} || ' months')::interval)::date
    ORDER BY h.code, m.year DESC, m.month DESC
  `) as MetricRow[];

  return NextResponse.json({ ok: true, rows, months_lookback: lookback }, { headers: NO_STORE });
}
