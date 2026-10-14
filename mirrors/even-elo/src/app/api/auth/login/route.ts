import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { verifyPin, createToken, setSessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

// In-memory rate limit per serverless instance: 5 attempts / 15 min / email.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(key: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }
  entry.count++;
  if (entry.count > MAX_ATTEMPTS) return { allowed: false, remaining: 0 };
  return { allowed: true, remaining: MAX_ATTEMPTS - entry.count };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, pin } = body ?? {};
    if (!email || !pin) {
      return NextResponse.json(
        { ok: false, error: "Email and PIN are required" },
        { status: 400 },
      );
    }

    const key = String(email).toLowerCase().trim();
    const { allowed } = checkRateLimit(key);
    if (!allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many login attempts. Wait 15 minutes." },
        { status: 429 },
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

    const rows = (await sql`
      SELECT
        p.id::text          AS id,
        p.email,
        p.full_name,
        p.password_hash,
        p.position_id::text AS position_id,
        pos.position_name   AS position_label,
        p.hospital_id::text AS hospital_id,
        h.code              AS hospital_code,
        p.status,
        p.is_super_admin,
        p.is_sgc_member,
        p.is_hr,
        p.is_site_medical_head,
        (SELECT base.must_change_pin FROM profiles base WHERE base.id = p.id) AS must_change_pin
      FROM profiles_with_roles p
      JOIN positions pos ON pos.id = p.position_id
      JOIN hospitals h   ON h.id   = p.hospital_id
      WHERE p.email = ${key}
      LIMIT 1
    `) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No account found with this email." },
        { status: 401 },
      );
    }
    const p = rows[0];

    if (p.status === "pending_approval") {
      return NextResponse.json(
        { ok: false, error: "Your account is pending admin approval." },
        { status: 403 },
      );
    }
    if (p.status === "suspended") {
      return NextResponse.json(
        { ok: false, error: "Your account is suspended." },
        { status: 403 },
      );
    }
    if (p.status === "rejected") {
      return NextResponse.json(
        { ok: false, error: "Your account was rejected." },
        { status: 403 },
      );
    }
    if (p.status === "deactivated") {
      return NextResponse.json(
        { ok: false, error: "Your account has been deactivated." },
        { status: 403 },
      );
    }

    const ok = await verifyPin(String(pin), p.password_hash as string);
    if (!ok) {
      return NextResponse.json(
        { ok: false, error: "Incorrect PIN." },
        { status: 401 },
      );
    }

    await sql`UPDATE profiles SET last_login_at = NOW() WHERE id = ${p.id as string}::uuid`;

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
      must_change_pin: Boolean(p.must_change_pin),
    });
    await setSessionCookie(token);

    // Readable position cookie for client-side "Stamped as" displays
    const { cookies } = await import("next/headers");
    const cs = await cookies();
    cs.set("epi_position", p.position_label as string, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return NextResponse.json(
      {
        ok: true,
        profile: {
          id: p.id,
          email: p.email,
          full_name: p.full_name,
          position: p.position_label,
          hospital: p.hospital_code,
          is_super_admin: Boolean(p.is_super_admin),
        },
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
