import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CR.5: surfaces what AddEngagementModal + AddPhysicianModal extend-flow need
// to render the auto-carry preview. Returns existing engagements + active
// privileges grouped by source hospital. Caller filters by `excludeHospitalId`
// (the hospital that's about to gain a new engagement) on the client side.
const CATEGORY_ORDER: Record<string, number> = {
  active: 5,
  provisional: 4,
  visiting_consultant: 3,
  locum_tenens: 2,
  affiliate: 1,
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const engagements = (await sql`
    SELECT
      e.id::text AS id,
      e.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      e.category,
      e.status,
      e.start_date::text AS start_date
    FROM physician_engagements e
    JOIN hospitals h ON h.id = e.hospital_id
    WHERE e.physician_id = ${id}::uuid
      AND e.status = 'active'
  `) as Array<{ id: string; hospital_id: string; hospital_code: string; category: string; status: string; start_date: string }>;

  const privileges = (await sql`
    SELECT
      pr.id::text AS id,
      pr.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      pr.procedure_or_specialty,
      pr.is_core,
      pr.expires_at::text AS expires_at,
      pr.granted_date::text AS granted_date,
      pr.basis
    FROM privileges pr
    JOIN hospitals h ON h.id = pr.hospital_id
    WHERE pr.physician_id = ${id}::uuid
      AND pr.withdrawn_date IS NULL
    ORDER BY pr.is_core DESC, pr.granted_date DESC
  `) as Array<{ id: string; hospital_id: string; hospital_code: string; procedure_or_specialty: string; is_core: boolean; expires_at: string | null; granted_date: string; basis: string }>;

  // Pre-compute the "most significant category" so the modal can suggest it.
  let mostSignificantCategory: string | null = null;
  let bestScore = -1;
  for (const e of engagements) {
    const sc = CATEGORY_ORDER[e.category] ?? 0;
    if (sc > bestScore) {
      bestScore = sc;
      mostSignificantCategory = e.category;
    }
  }

  // Group privileges by source hospital_code for easy modal rendering
  const privileges_by_hospital: Record<string, typeof privileges> = {};
  for (const p of privileges) {
    (privileges_by_hospital[p.hospital_code] ||= []).push(p);
  }

  return NextResponse.json(
    {
      ok: true,
      engagements,
      privileges,
      privileges_by_hospital,
      most_significant_category: mostSignificantCategory,
    },
    { headers: NO_STORE },
  );
}
