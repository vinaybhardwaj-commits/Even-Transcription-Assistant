import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { sendEmail, wrapHtml } from "@/lib/email";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(qid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`
    SELECT id::text AS id, physician_id::text AS physician_id, degree, institution, institution_tier, year_completed, country, verified, verified_by::text AS verified_by, verified_at
    FROM qualifications WHERE id = ${qid}::uuid AND physician_id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const b = before[0];

  const merged = {
    degree: body.degree ?? b.degree,
    institution: body.institution !== undefined ? body.institution : b.institution,
    institution_tier: body.institution_tier !== undefined ? body.institution_tier : b.institution_tier,
    year_completed: body.year_completed !== undefined ? body.year_completed : b.year_completed,
    country: body.country !== undefined ? body.country : b.country,
  };

  // Verify action: only if explicitly requested AND user has permission
  let setVerified = b.verified as boolean;
  let setVerifiedBy = b.verified_by as string | null;
  let setVerifiedAt: string | null = b.verified_at as string | null;
  if (body.verified === true) {
    // role check
    const me = await sql`SELECT is_super_admin, is_hr, is_site_medical_head FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid`;
    const meRow = (me as Array<Record<string, unknown>>)[0];
    if (!meRow.is_super_admin && !meRow.is_hr && !meRow.is_site_medical_head) {
      return NextResponse.json({ ok: false, error: "Only super_admin, HR, or Site Medical Head can verify" }, { status: 403, headers: NO_STORE });
    }
    setVerified = true;
    setVerifiedBy = actor.profileId;
    setVerifiedAt = new Date().toISOString();
  } else if (body.verified === false) {
    setVerified = false;
    setVerifiedBy = null;
    setVerifiedAt = null;
  }

  await sql`
    UPDATE qualifications SET
      degree           = ${merged.degree as string},
      institution      = ${(merged.institution as string | null) ?? null},
      institution_tier = ${(merged.institution_tier as string | null) ?? null},
      year_completed   = ${(merged.year_completed as number | null) ?? null},
      country          = ${(merged.country as string | null) ?? null},
      verified         = ${setVerified},
      verified_by      = ${setVerifiedBy ? setVerifiedBy : null},
      verified_at      = ${setVerifiedAt}
    WHERE id = ${qid}::uuid
  `;

  const after = (await sql`
    SELECT id::text AS id, physician_id::text AS physician_id, degree, institution, institution_tier, year_completed, verified, verified_at
    FROM qualifications WHERE id = ${qid}::uuid
  `) as Array<Record<string, unknown>>;

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${body.verified === true ? "verify" : "update"},
      'qualification',
      ${qid},
      ${JSON.stringify({ ...b, physician_id: id })}::jsonb,
      ${JSON.stringify({ ...after[0], physician_id: id })}::jsonb
    )
  `;
  // N.2 — if this PATCH just transitioned the qualification to verified, notify the
  // physician. Their own degree name is not sensitive; no reviewer identity included.
  if (body.verified === true && !(b.verified as boolean)) {
    const ph = (await sql`SELECT email, full_name FROM physicians WHERE id = ${id}::uuid LIMIT 1`) as Array<{ email: string | null; full_name: string }>;
    if (ph.length > 0 && ph[0].email) {
      const deg = String(merged.degree ?? "");
      void sendEmail({
        to: ph[0].email,
        subject: "A qualification on your Even profile was verified",
        html: wrapHtml("Qualification verified", `<p>Your qualification${deg ? ` <strong>${deg}</strong>` : ""} has been verified on your Even physician profile.</p><p>Sign in to your physician portal to review your verified credentials.</p>`),
      }).catch(() => undefined);
    }
  }

  return NextResponse.json({ ok: true, qualification: after[0] }, { headers: NO_STORE });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(qid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`SELECT id::text AS id, degree FROM qualifications WHERE id = ${qid}::uuid AND physician_id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  await sql`DELETE FROM qualifications WHERE id = ${qid}::uuid`;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json)
    VALUES (${actor.profileId}::uuid, 'delete', 'qualification', ${qid}, ${JSON.stringify({ ...before[0], physician_id: id })}::jsonb)
  `;
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
