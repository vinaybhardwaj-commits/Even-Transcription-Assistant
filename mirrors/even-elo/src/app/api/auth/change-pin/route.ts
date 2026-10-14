import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { getCurrentUser, createToken, setSessionCookie, hashPin, isValidPin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** POST /api/auth/change-pin — user sets a new PIN, clears must_change_pin, re-issues the session. */
export async function POST(req: NextRequest) {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });

  const body = await req.json().catch(() => ({}));
  const newPin = String(body?.new_pin ?? "");
  if (!isValidPin(newPin)) return NextResponse.json({ ok: false, error: "PIN must be exactly 4 digits" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const hash = await hashPin(newPin);
  await sql`UPDATE profiles SET password_hash = ${hash}, must_change_pin = false, updated_at = NOW() WHERE id = ${u.profileId}::uuid`;
  await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (${u.profileId}::uuid, 'pin_change_self', 'profile', ${u.profileId}, ${JSON.stringify({ must_change_pin: false })}::jsonb)`;

  const token = await createToken({
    profileId: u.profileId, email: u.email, full_name: u.full_name,
    position_id: u.position_id, position_label: u.position_label,
    hospital_id: u.hospital_id, hospital_code: u.hospital_code, status: u.status,
    is_super_admin: u.is_super_admin, is_sgc_member: u.is_sgc_member, is_hr: u.is_hr,
    is_site_medical_head: u.is_site_medical_head, must_change_pin: false,
  });
  await setSessionCookie(token);

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
