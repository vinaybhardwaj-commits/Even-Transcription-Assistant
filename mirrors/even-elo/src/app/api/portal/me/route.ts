import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET() {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT id::text AS id, full_name, preferred_name, primary_specialty,
           registration_number, registration_council, registration_expiry,
           indemnity_expiry, email, phone, date_joined_network, current_status, notes
    FROM physicians WHERE id = ${me.physicianId}::uuid
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return portalJson({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  const engagements = (await sql`
    SELECT e.id::text AS id, e.hospital_id::text AS hospital_id, e.category, e.status, e.start_date, h.code AS hospital_code, h.name AS hospital_name
    FROM physician_engagements e JOIN hospitals h ON h.id = e.hospital_id
    WHERE e.physician_id = ${me.physicianId}::uuid
    ORDER BY e.start_date DESC NULLS LAST
  `) as Array<Record<string, unknown>>;

  return portalJson({ ok: true, physician: rows[0], engagements }, { headers: NO_STORE });
}
