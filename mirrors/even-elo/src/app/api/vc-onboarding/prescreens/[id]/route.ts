import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      v.id::text AS id,
      v.prospective_email,
      v.prospective_full_name,
      v.prospective_specialty,
      h.code AS hospital_code,
      h.name AS hospital_name,
      v.years_post_postgraduate,
      v.prior_corporate_hospitals,
      v.commitments_acknowledged,
      v.red_flags,
      v.decision,
      v.decision_rationale,
      v.cooldown_override,
      v.stage,
      pp.email AS prescreened_by_email,
      v.prescreened_at,
      v.decided_at,
      v.physician_id::text AS physician_id,
      v.created_at, v.updated_at
    FROM vc_prescreens v
    JOIN hospitals h  ON h.id = v.hospital_id
    JOIN profiles pp ON pp.id = v.prescreened_by
    WHERE v.id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  // v3.0e: include the multi-site hospital_codes[] + per-hospital observation case counts
  const hospitalRows = (await sql`
    SELECT h.code FROM vc_prescreen_hospitals vph
    JOIN hospitals h ON h.id = vph.hospital_id
    WHERE vph.prescreen_id = ${id}::uuid
    ORDER BY h.code
  `) as Array<{ code: string }>;
  const caseRows = (await sql`
    SELECT h.code, COUNT(*)::int AS n
    FROM vc_observation_cases o
    JOIN hospitals h ON h.id = o.hospital_id
    WHERE o.prescreen_id = ${id}::uuid
    GROUP BY h.code
  `) as Array<{ code: string; n: number }>;
  const cases_per_hospital: Record<string, number> = {};
  for (const c of caseRows) cases_per_hospital[c.code] = c.n;

  // CR.2: surface trigger (derived from first observation case on the
  // prescreen — uniform per prescreen). Defaults to new_visiting_consultant
  // when there are no cases yet so the UI back-compat stays.
  const trigRow = (await sql`
    SELECT trigger FROM vc_observation_cases WHERE prescreen_id = ${id}::uuid ORDER BY case_number ASC LIMIT 1
  `) as Array<{ trigger: string }>;
  // Also surface fppe_from_profile flag (set by /api/physicians/[id]/fppe in
  // commitments_acknowledged) so UI knows this is a profile-triggered FPPE.
  const meta = (rows[0] as Record<string, unknown>).commitments_acknowledged as Record<string, unknown> | null;
  const fppeFromProfile = !!(meta && (meta as { fppe_from_profile?: boolean }).fppe_from_profile);
  const derivedTrigger = trigRow.length > 0
    ? trigRow[0].trigger
    : (fppeFromProfile && (meta as { trigger?: string }).trigger ? (meta as { trigger: string }).trigger : "new_visiting_consultant");

  return NextResponse.json({
    ok: true,
    prescreen: {
      ...rows[0],
      hospital_codes: hospitalRows.map((r) => r.code),
      cases_per_hospital,
      trigger: derivedTrigger,
      fppe_from_profile: fppeFromProfile,
    },
  }, { headers: NO_STORE });
}
