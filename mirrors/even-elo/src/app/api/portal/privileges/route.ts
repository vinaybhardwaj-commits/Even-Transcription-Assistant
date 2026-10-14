import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET /api/portal/privileges — own privileges, read-only (#— physicians can't change their own). */
export async function GET() {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT p.id::text AS id, p.procedure_or_specialty, p.is_core, p.granted_date, p.expires_at,
           p.withdrawn_date, p.withdrawn_reason, h.code AS hospital_code
    FROM privileges p JOIN hospitals h ON h.id = p.hospital_id
    WHERE p.physician_id = ${me.physicianId}::uuid
    ORDER BY p.is_core DESC, h.code, p.procedure_or_specialty
  `) as Array<Record<string, unknown>>;
  return portalJson({ ok: true, rows }, { headers: NO_STORE });
}
