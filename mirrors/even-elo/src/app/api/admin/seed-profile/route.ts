import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST /api/admin/seed-profile
 *
 * Admin-only profile seeder. URL-gated (same pattern as the other
 * admin/* bootstrap endpoints) — stays in the codebase until the proper
 * Admin Module replaces it.
 *
 * Body:
 *   email             — required, must be @even.in
 *   full_name         — required
 *   pin               — required, 4 digits (bcrypt-hashed server-side)
 *   position_name     — required, must match an existing position at the hospital
 *   hospital_code     — defaults to 'EHRC'
 *   status            — defaults to 'active' (override to 'pending_approval' if you
 *                       want the user to go through the normal /admin/pending flow)
 *   is_super_admin    — defaults to false
 *   is_sgc_member     — defaults to false
 *   is_hr             — defaults to false
 *   is_site_medical_head — defaults to false
 *
 * Behavior:
 *   - If the email already exists, returns 409 with the existing id.
 *     Use /admin/users to edit role flags or status.
 *   - Inserts the profile + returns the new id.
 */
export async function POST(req: NextRequest) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const body = await req.json();
  const {
    email,
    full_name,
    pin,
    position_name,
    hospital_code = "EHRC",
    status = "active",
    is_super_admin = false,
    roles = [],
  } = body ?? {};

  if (!email || typeof email !== "string" || !email.toLowerCase().endsWith("@even.in")) {
    return NextResponse.json({ ok: false, error: "email required (must end @even.in)" }, { status: 400, headers: NO_STORE });
  }
  if (!full_name || typeof full_name !== "string" || !full_name.trim()) {
    return NextResponse.json({ ok: false, error: "full_name required" }, { status: 400, headers: NO_STORE });
  }
  if (!pin || typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return NextResponse.json({ ok: false, error: "pin must be exactly 4 digits" }, { status: 400, headers: NO_STORE });
  }
  if (!position_name || typeof position_name !== "string") {
    return NextResponse.json({ ok: false, error: "position_name required" }, { status: 400, headers: NO_STORE });
  }
  if (!["pending_approval", "active", "suspended", "rejected"].includes(status)) {
    return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400, headers: NO_STORE });
  }

  const lowerEmail = email.toLowerCase().trim();

  // 409 if already exists
  const existing = (await sql`SELECT id::text AS id, email FROM profiles WHERE email = ${lowerEmail}`) as Array<{ id: string; email: string }>;
  if (existing.length > 0) {
    return NextResponse.json(
      { ok: false, error: `Profile with email ${lowerEmail} already exists. Edit via /admin/users.`, existing_id: existing[0].id },
      { status: 409, headers: NO_STORE },
    );
  }

  // Resolve hospital + position (must match a seeded position at that hospital)
  const hosp = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
  if (hosp.length === 0) {
    return NextResponse.json({ ok: false, error: `Hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });
  }
  const pos = (await sql`SELECT id::text AS id FROM positions WHERE position_name = ${position_name} LIMIT 1`) as Array<{ id: string }>;
  if (pos.length === 0) {
    return NextResponse.json({ ok: false, error: `Position '${position_name}' not found at ${hospital_code}` }, { status: 400, headers: NO_STORE });
  }

  const passwordHash = await bcrypt.hash(pin, 10);

  const inserted = (await sql`
    INSERT INTO profiles (
      email, full_name, password_hash, position_id, hospital_id, status,
      is_super_admin
    ) VALUES (
      ${lowerEmail}, ${full_name.trim()}, ${passwordHash},
      ${pos[0].id}::uuid, ${hosp[0].id}::uuid, ${status},
      ${Boolean(is_super_admin)}
    )
    RETURNING id::text AS id, email, full_name, status, is_super_admin
  `) as Array<Record<string, unknown>>;
  const newProfileId = inserted[0].id as string;

  // Optional per-hospital roles: [{ hospital_code, role }, ...]
  const grantedRoles: Array<{ hospital_code: string; role: string }> = [];
  if (Array.isArray(roles) && roles.length > 0) {
    for (const r of roles) {
      if (!r || typeof r.hospital_code !== "string" || typeof r.role !== "string") continue;
      if (!["site_medical_head","hr","sgc_member"].includes(r.role)) continue;
      const rh = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${r.hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
      if (rh.length === 0) continue;
      await sql`
        INSERT INTO profile_hospital_roles (profile_id, hospital_id, role, granted_by)
        VALUES (${newProfileId}::uuid, ${rh[0].id}::uuid, ${r.role}, NULL)
        ON CONFLICT DO NOTHING
      `;
      grantedRoles.push({ hospital_code: r.hospital_code, role: r.role });
    }
  }

  await sql`
    INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
    VALUES (
      'admin_seed',
      'profile',
      ${inserted[0].id as string},
      ${JSON.stringify({
        email: lowerEmail,
        full_name,
        position_name,
        hospital_code,
        status,
        is_super_admin: Boolean(is_super_admin),
        granted_roles: grantedRoles,
        seeded_via: "/api/admin/seed-profile",
      })}::jsonb
    )
  `;

  return NextResponse.json({ ok: true, profile: inserted[0] }, { headers: NO_STORE });
}
