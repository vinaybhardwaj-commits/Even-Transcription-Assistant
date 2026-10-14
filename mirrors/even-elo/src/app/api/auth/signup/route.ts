import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  hashPin,
  isValidEvenEmail,
  isValidPin,
  isSuperuserEmail,
  createToken,
  setSessionCookie,
} from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, full_name, pin, position_id, hospital_code } = body ?? {};

    if (!email || !full_name || !pin || !position_id) {
      return NextResponse.json(
        { ok: false, error: "Email, full name, PIN, and position are required" },
        { status: 400 },
      );
    }
    if (!isValidEvenEmail(email)) {
      return NextResponse.json(
        { ok: false, error: "Only @even.in email addresses are allowed" },
        { status: 400 },
      );
    }
    if (!isValidPin(pin)) {
      return NextResponse.json(
        { ok: false, error: "PIN must be exactly 4 digits" },
        { status: 400 },
      );
    }

    const url = process.env.DATABASE_URL;
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "DATABASE_URL not configured" },
        { status: 500 },
      );
    }
    const sql = neon(url);

    // Hospital — default EHRC for v1
    const hospitalCode = (hospital_code as string) || "EHRC";
    const hospRows = (await sql`
      SELECT id::text AS id FROM hospitals WHERE code = ${hospitalCode} AND is_active = true LIMIT 1
    `) as Array<{ id: string }>;
    if (hospRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: `Hospital ${hospitalCode} not active` },
        { status: 400 },
      );
    }
    const hospitalId = hospRows[0].id;

    // Position must exist (shared catalogue in v3.0a — no hospital_id check)
    const posRows = (await sql`
      SELECT id::text AS id FROM positions WHERE id = ${position_id}::uuid LIMIT 1
    `) as Array<{ id: string }>;
    if (posRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Position not found at this hospital" },
        { status: 400 },
      );
    }

    // Email collision
    const existing = (await sql`
      SELECT id, status FROM profiles WHERE email = ${String(email).toLowerCase()} LIMIT 1
    `) as Array<{ id: string; status: string }>;
    if (existing.length > 0) {
      const s = existing[0].status;
      const msg =
        s === "active"
          ? "Already registered. Please log in."
          : s === "pending_approval"
          ? "Already registered, pending approval."
          : "An account exists with this email.";
      return NextResponse.json({ ok: false, error: msg }, { status: 409 });
    }

    const passwordHash = await hashPin(String(pin));
    const isSuperuser = isSuperuserEmail(email);
    const status = isSuperuser ? "active" : "pending_approval";

    // Validate optional requested_roles (v3.0c). Drop unknown roles/hospital codes silently.
    const validRoles = new Set(["site_medical_head", "hr", "sgc_member"]);
    type Req = { hospital_code: string; role: string };
    const reqRaw: unknown = (body as Record<string, unknown>)?.requested_roles;
    const reqArr: Req[] = Array.isArray(reqRaw)
      ? (reqRaw as Array<Record<string, unknown>>)
          .map((r) => ({ hospital_code: String(r?.hospital_code ?? "").trim().toUpperCase(), role: String(r?.role ?? "").trim() }))
          .filter((r) => r.hospital_code && validRoles.has(r.role))
      : [];
    // De-dup
    const seen = new Set<string>();
    const requestedRoles: Req[] = [];
    for (const r of reqArr) {
      const k = `${r.hospital_code}|${r.role}`;
      if (seen.has(k)) continue;
      seen.add(k);
      requestedRoles.push(r);
    }

    const inserted = (await sql`
      INSERT INTO profiles (
        email, full_name, password_hash, position_id, hospital_id, status, is_super_admin, requested_roles
      ) VALUES (
        ${String(email).toLowerCase()},
        ${String(full_name).trim()},
        ${passwordHash},
        ${position_id}::uuid,
        ${hospitalId}::uuid,
        ${status},
        ${isSuperuser},
        ${JSON.stringify(requestedRoles)}::jsonb
      )
      RETURNING id::text AS id, email, full_name, status
    `) as Array<Record<string, unknown>>;
    const newProfile = inserted[0];

    if (isSuperuser) {
      // Auto-login the superuser. Fetch the full join for the JWT payload.
      const rows = (await sql`
        SELECT
          p.id::text          AS id,
          p.email,
          p.full_name,
          p.position_id::text AS position_id,
          pos.position_name   AS position_label,
          p.hospital_id::text AS hospital_id,
          h.code              AS hospital_code,
          p.status,
          p.is_super_admin,
          p.is_sgc_member,
          p.is_hr,
          p.is_site_medical_head
        FROM profiles_with_roles p
        JOIN positions pos ON pos.id = p.position_id
        JOIN hospitals h   ON h.id   = p.hospital_id
        WHERE p.id = ${newProfile.id as string}::uuid
      `) as Array<Record<string, unknown>>;
      const p = rows[0];
      const token = await createToken({
        profileId: p.id as string,
        email: p.email as string,
        full_name: p.full_name as string,
        position_id: p.position_id as string,
        position_label: p.position_label as string,
        hospital_id: p.hospital_id as string,
        hospital_code: p.hospital_code as string,
        status: p.status as string,
        is_super_admin: Boolean(p.is_super_admin),
        is_sgc_member: Boolean(p.is_sgc_member),
        is_hr: Boolean(p.is_hr),
        is_site_medical_head: Boolean(p.is_site_medical_head),
      });
      await setSessionCookie(token);
      const { cookies } = await import("next/headers");
      const cs = await cookies();
      cs.set("epi_position", p.position_label as string, {
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
    }

    return NextResponse.json(
      {
        ok: true,
        profile: newProfile,
        autoLogin: isSuperuser,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
