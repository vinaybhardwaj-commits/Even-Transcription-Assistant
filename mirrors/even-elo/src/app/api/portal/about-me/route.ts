import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/portal/about-me — feedback/incidents filed about the logged-in physician.
 * Full detail, but the reporter is masked to "Anonymous" when anonymous_flag is set
 * (#4/#6 — admins still see the real reporter elsewhere; this is the doctor-facing view).
 */
export async function GET() {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT
      i.id::text AS id, i.polarity, i.source, i.category, i.severity, i.commendation_category,
      i.patient_rating, i.narrative, i.status, i.anonymous_flag, i.submitted_at, i.retraction_reason,
      h.code AS hospital_code,
      CASE
        WHEN i.anonymous_flag THEN 'Anonymous'
        WHEN i.submitter_physician_id IS NOT NULL THEN sp.full_name
        WHEN i.submitter_user_id IS NOT NULL THEN COALESCE(pr.email, i.submitter_position_at_time)
        ELSE 'Unknown'
      END AS reporter_display,
      (SELECT COALESCE(json_agg(json_build_object('id', r.id::text, 'text', r.reply_text, 'at', r.replied_at,
          'author', COALESCE(rph.full_name, rpr.email, 'Staff')) ORDER BY r.replied_at), '[]'::json)
         FROM incident_replies r
         LEFT JOIN physicians rph ON rph.id = r.replied_by_physician_id
         LEFT JOIN profiles rpr ON rpr.id = r.replied_by_profile_id
         WHERE r.incident_id = i.id) AS replies
    FROM incidents i
    LEFT JOIN physicians sp ON sp.id = i.submitter_physician_id
    LEFT JOIN profiles pr ON pr.id = i.submitter_user_id
    LEFT JOIN hospitals h ON h.id = i.hospital_id
    WHERE i.target_physician_id = ${me.physicianId}::uuid
    ORDER BY i.submitted_at DESC
  `) as Array<Record<string, unknown>>;
  return portalJson({ ok: true, rows }, { headers: NO_STORE });
}
