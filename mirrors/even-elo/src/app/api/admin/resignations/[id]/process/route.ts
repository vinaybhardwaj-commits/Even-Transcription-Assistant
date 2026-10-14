import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { sendEmail, wrapHtml } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/admin/resignations/[id]/process — set the engagement(s) to 'resigned' + mark the request processed. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const me = (await sql`SELECT is_super_admin, is_site_medical_head FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean; is_site_medical_head: boolean }>;
  if (me.length === 0 || !(me[0].is_super_admin || me[0].is_site_medical_head)) return NextResponse.json({ ok: false, error: "Not permitted" }, { status: 403, headers: NO_STORE });

  const req = (await sql`SELECT r.physician_id::text AS physician_id, r.hospital_id::text AS hospital_id, r.status, p.email AS physician_email, p.full_name AS physician_name FROM resignation_requests r JOIN physicians p ON p.id = r.physician_id WHERE r.id = ${id}::uuid LIMIT 1`) as Array<{ physician_id: string; hospital_id: string | null; status: string; physician_email: string | null; physician_name: string }>;
  if (req.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  if (req[0].status !== "pending") return NextResponse.json({ ok: false, error: "already processed" }, { status: 409, headers: NO_STORE });

  if (req[0].hospital_id) {
    await sql`UPDATE physician_engagements SET status='resigned', status_reason='Resignation processed' WHERE physician_id = ${req[0].physician_id}::uuid AND hospital_id = ${req[0].hospital_id}::uuid AND status='active'`;
  } else {
    await sql`UPDATE physician_engagements SET status='resigned', status_reason='Resignation processed' WHERE physician_id = ${req[0].physician_id}::uuid AND status='active'`;
  }
  await sql`UPDATE resignation_requests SET status='processed', processed_by=${actor.profileId}::uuid, processed_at=NOW() WHERE id = ${id}::uuid`;
  await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json) VALUES (${actor.profileId}::uuid, 'resignation_processed', 'physician', ${req[0].physician_id}, ${JSON.stringify({ request_id: id, hospital_id: req[0].hospital_id })}::jsonb)`;
  // N.2 — confirm to the physician that their resignation request has been processed.
  if (req[0].physician_email) {
    void sendEmail({
      to: req[0].physician_email,
      subject: "Your resignation request has been processed",
      html: wrapHtml("Resignation processed", `<p>Your resignation request has been processed by the hospital administration.</p><p>Your engagement status has been updated. If you have questions, please contact the Medical Administration office.</p>`),
    }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
