import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { getHospitalFilterId } from "@/lib/hospital-filter";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

type Spec = { specialty: string; vc: number; staff: number; total: number };
type Hosp = { code: string; name: string; vc: number; staff: number; total: number; specialties: Spec[] };

/**
 * GET /api/admin/census — DR.6 (nested).
 * Counting rule (Q-E): one distinct doctor per hospital (deduped within a hospital),
 * counted again per other hospital. VC if any visiting_consultant active engagement at
 * that hospital, else Staff. Specialty = primary_specialty. Hospital-filter aware (Q-D).
 * Returns by_hospital[] each carrying its own specialties[], plus headline counts.
 * Only hospitals with active doctors appear.
 */
export async function GET() {
  try { await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const hid = await getHospitalFilterId();

  const hosp = (hid
    ? await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' AND pe.hospital_id=${hid}::uuid GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, h.name, count(*) FILTER (WHERE base.is_vc)::int AS vc, count(*) FILTER (WHERE NOT base.is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, h.name ORDER BY h.name`
    : await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, h.name, count(*) FILTER (WHERE base.is_vc)::int AS vc, count(*) FILTER (WHERE NOT base.is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, h.name ORDER BY h.name`) as Array<Omit<Hosp, "specialties">>;

  const specRows = (hid
    ? await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc,
            max(COALESCE(NULLIF(trim(p.primary_specialty),''),'Unspecified')) AS specialty
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' AND pe.hospital_id=${hid}::uuid GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, base.specialty, count(*) FILTER (WHERE is_vc)::int AS vc, count(*) FILTER (WHERE NOT is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, base.specialty ORDER BY total DESC, base.specialty`
    : await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc,
            max(COALESCE(NULLIF(trim(p.primary_specialty),''),'Unspecified')) AS specialty
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, base.specialty, count(*) FILTER (WHERE is_vc)::int AS vc, count(*) FILTER (WHERE NOT is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, base.specialty ORDER BY total DESC, base.specialty`) as Array<{ code: string; specialty: string; vc: number; staff: number; total: number }>;

  const byCode = new Map<string, Spec[]>();
  for (const r of specRows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code)!.push({ specialty: r.specialty, vc: r.vc, staff: r.staff, total: r.total });
  }
  const by_hospital: Hosp[] = hosp.map((h) => ({ ...h, specialties: byCode.get(h.code) ?? [] }));
  const specialties_total = new Set(specRows.map((r) => r.specialty)).size;

  return NextResponse.json({ ok: true, scope: hid ? "hospital" : "all", hospitals: by_hospital.length, specialties: specialties_total, by_hospital }, { headers: NO_STORE });
}
