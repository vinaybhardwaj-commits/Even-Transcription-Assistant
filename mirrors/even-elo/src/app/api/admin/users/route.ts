import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import { actorFromRequest } from "@/lib/auth";
import { sendEmail, wrapHtml } from "@/lib/email";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const ROLE_VALUES = new Set(["site_medical_head", "hr", "sgc_member"]);

/**
 * POST /api/admin/users — Users Module #1/#3/#4.
 * super_admin creates a user in-UI. Admin sets a temp 4-digit PIN; the user is
 * active immediately and forced to change the PIN on first login (must_change_pin).
 * Per-hospital roles can be passed here OR assigned afterward via the Roles grid.
 */
export async function POST(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const meRows = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (meRows.length === 0 || !meRows[0].is_super_admin) {
    return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });
  }

  const body = await req.json();
  const { email, full_name, pin, position_name, hospital_code = "EHRC", is_super_admin = false, roles = [] } = body ?? {};

  if (!email || typeof email !== "string" || !email.toLowerCase().endsWith("@even.in"))
    return NextResponse.json({ ok: false, error: "email required (must end @even.in)" }, { status: 400, headers: NO_STORE });
  if (!full_name || typeof full_name !== "string" || !full_name.trim())
    return NextResponse.json({ ok: false, error: "full_name required" }, { status: 400, headers: NO_STORE });
  if (!pin || typeof pin !== "string" || !/^\d{4}$/.test(pin))
    return NextResponse.json({ ok: false, error: "pin must be exactly 4 digits" }, { status: 400, headers: NO_STORE });
  if (!position_name || typeof position_name !== "string")
    return NextResponse.json({ ok: false, error: "position_name required" }, { status: 400, headers: NO_STORE });

  const lowerEmail = email.toLowerCase().trim();
  const existing = (await sql`SELECT id::text AS id FROM profiles WHERE email = ${lowerEmail}`) as Array<{ id: string }>;
  if (existing.length > 0)
    return NextResponse.json({ ok: false, error: `A user with ${lowerEmail} already exists.`, existing_id: existing[0].id }, { status: 409, headers: NO_STORE });

  const hosp = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
  if (hosp.length === 0) return NextResponse.json({ ok: false, error: `Hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });
  const pos = (await sql`SELECT id::text AS id FROM positions WHERE position_name = ${position_name} LIMIT 1`) as Array<{ id: string }>;
  if (pos.length === 0) return NextResponse.json({ ok: false, error: `Position '${position_name}' not found` }, { status: 400, headers: NO_STORE });

  const passwordHash = await bcrypt.hash(pin, 10);
  const inserted = (await sql`
    INSERT INTO profiles (email, full_name, password_hash, position_id, hospital_id, status, is_super_admin, must_change_pin)
    VALUES (${lowerEmail}, ${full_name.trim()}, ${passwordHash}, ${pos[0].id}::uuid, ${hosp[0].id}::uuid, 'active', ${Boolean(is_super_admin)}, true)
    RETURNING id::text AS id, email, full_name, status, is_super_admin
  `) as Array<Record<string, unknown>>;
  const newId = inserted[0].id as string;

  const grantedRoles: Array<{ hospital_code: string; role: string }> = [];
  if (Array.isArray(roles)) {
    for (const r of roles) {
      if (!r || typeof r.hospital_code !== "string" || typeof r.role !== "string" || !ROLE_VALUES.has(r.role)) continue;
      const rh = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${r.hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
      if (rh.length === 0) continue;
      await sql`INSERT INTO profile_hospital_roles (profile_id, hospital_id, role, granted_by) VALUES (${newId}::uuid, ${rh[0].id}::uuid, ${r.role}, ${actor.profileId}::uuid) ON CONFLICT DO NOTHING`;
      grantedRoles.push({ hospital_code: r.hospital_code, role: r.role });
    }
  }

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actor.profileId}::uuid, 'user_create', 'profile', ${newId},
      ${JSON.stringify({ email: lowerEmail, full_name, position_name, hospital_code, status: "active", is_super_admin: Boolean(is_super_admin), granted_roles: grantedRoles, must_change_pin: true, created_via: "/admin/users" })}::jsonb)
  `;
  // N.3 — invite email to the new user: their login (email) + temporary PIN
  // (force-changed on first sign-in via must_change_pin). Gated by EMAIL_SENDING_ENABLED.
  {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://governance.evenos.app";
    void sendEmail({
      to: lowerEmail,
      subject: "You've been added to the Even Physician Index",
      html: wrapHtml("Welcome to the Even Physician Index", `
        <p>Hi ${full_name.trim()},</p>
        <p>An account has been created for you on the Even Physician Index.</p>
        <p style="margin:16px 0;padding:12px 16px;background:#f5f5f4;border-radius:8px;">
          <strong>Sign in:</strong> <a href="${appUrl}" style="color:#0f766e;">${appUrl}</a><br>
          <strong>Email:</strong> ${lowerEmail}<br>
          <strong>Temporary PIN:</strong> <code style="font-size:15px;">${pin}</code>
        </p>
        <p>For your security, you'll be asked to set a new PIN the first time you sign in. This temporary PIN works only until then.</p>
        <p>If you weren't expecting this, please contact your administrator.</p>`),
    }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, profile: inserted[0] }, { headers: NO_STORE });
}
