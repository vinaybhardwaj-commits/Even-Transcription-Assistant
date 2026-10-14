import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET() {
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const me = (await sql`SELECT is_super_admin, is_site_medical_head FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean; is_site_medical_head: boolean }>;
  if (me.length === 0 || !(me[0].is_super_admin || me[0].is_site_medical_head)) return NextResponse.json({ ok: false, error: "Not permitted" }, { status: 403, headers: NO_STORE });
  const rows = (await sql`
    SELECT r.id::text AS id, r.physician_id::text AS physician_id, ph.full_name AS physician_name,
           r.reason, r.intended_last_date, r.status, r.requested_at, h.code AS hospital_code
    FROM resignation_requests r JOIN physicians ph ON ph.id = r.physician_id
    LEFT JOIN hospitals h ON h.id = r.hospital_id
    ORDER BY (r.status = 'pending') DESC, r.requested_at DESC LIMIT 100
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}
