import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";
import { buildDoctorSlug } from "@/lib/doctor-slug";
import { respondError } from "@/lib/respond";

/**
 * Resolve the canonical app URL for outbound links (login_url, email
 * footers). Reads APP_URL but overrides the legacy eta.even.in value
 * that's stuck in the Vercel env (would need V to update the dashboard).
 * Falls back to evenscribe.app (the canonical user-facing domain).
 */
function canonicalAppUrl(): string {
  const raw = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "https://evenscribe.app";
  // Hard override: the stale eta.even.in env value is unreachable
  if (/eta\.even\.in/i.test(raw)) return "https://evenscribe.app";
  return raw;
}

/**
 * POST /api/admin/bootstrap
 * Auth: Authorization: Bearer ${ADMIN_TOKEN}
 *
 * Idempotent setup endpoint for FIRST DEPLOY use only.
 * - Inserts V as admin_user (if missing)
 * - Inserts V as a doctor (if no doctor exists yet) with a known PIN
 *
 * Body (optional):
 *   { admin_email, admin_name, doctor_full_name, doctor_email, doctor_pin }
 *
 * Defaults: V's email + name, doctor PIN "1234" for first-time login.
 * Returns the doctor URL + PIN so V can immediately test.
 *
 * After Sprint 3 ships the admin Doctors UI, this endpoint should be
 * deleted — it's only here to unblock Sprint 1 testing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const nanoidDoc = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);

type AdminUser = { id: string; email: string };
type DoctorRow = { id: string; url_slug: string };

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.ADMIN_TOKEN ?? ""}`;
  if (!process.env.ADMIN_TOKEN || auth !== expected) {
    return respondError("FORBIDDEN", "Invalid admin token");
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* allow empty body */ }

  const adminEmail = (body.admin_email as string) ?? "vinay.bhardwaj@even.in";
  const adminName  = (body.admin_name  as string) ?? "Vinay Bhardwaj";
  const doctorFullName = (body.doctor_full_name as string) ?? "Vinay Bhardwaj";
  const doctorEmail = (body.doctor_email as string) ?? adminEmail;
  const doctorPin = (body.doctor_pin as string) ?? "1234";

  if (!/^\d{4}$/.test(doctorPin)) {
    return respondError("VALIDATION_FAILED", "doctor_pin must be 4 digits");
  }

  // 1. Upsert admin
  let admin: AdminUser;
  try {
    const existing = (await sql`
      SELECT id, email FROM admin_user WHERE email = ${adminEmail} LIMIT 1
    `) as AdminUser[];
    if (existing[0]) {
      admin = existing[0];
    } else {
      const pwHash = await bcrypt.hash("change-me-soon-please", 12);
      const inserted = (await sql`
        INSERT INTO admin_user (email, name, password_hash, role)
        VALUES (${adminEmail}, ${adminName}, ${pwHash}, 'super')
        RETURNING id, email
      `) as AdminUser[];
      admin = inserted[0]!;
    }
  } catch (e) {
    return respondError("PIPELINE_FAILED", "admin_user insert failed: " + String(e));
  }

  // 2. Upsert doctor — by email (if exists, return existing)
  let doctor: DoctorRow;
  try {
    const existing = (await sql`
      SELECT id, url_slug FROM clinician WHERE email = ${doctorEmail} AND deleted_at IS NULL LIMIT 1
    `) as DoctorRow[];
    if (existing[0]) {
      doctor = existing[0];
      // Reset PIN if requested via body (idempotent re-bootstrap)
      if (body.doctor_pin) {
        const pinHash = await bcrypt.hash(doctorPin, 12);
        await sql`
          UPDATE clinician
             SET pin_hash = ${pinHash}, pin_set_at = NOW(),
                 failed_pin_count = 0, locked_until = NULL,
                 status = 'active', updated_at = NOW()
           WHERE id = ${doctor.id}
        `;
      }
    } else {
      const id = "doc_" + nanoidDoc();
      const { full: fullSlug, token } = buildDoctorSlug(doctorFullName);
      const pinHash = await bcrypt.hash(doctorPin, 12);
      const inserted = (await sql`
        INSERT INTO clinician (
          id, legacy_doctor_id, clinician_type, full_name, email, url_slug, url_token, pin_hash, pin_set_at,
          status, created_by
        ) VALUES (
          ${id}, NULL, 'physician'::clinician_type, ${doctorFullName}, ${doctorEmail}, ${fullSlug}, ${token},
          ${pinHash}, NOW(), 'active', ${admin.id}::uuid
        )
        RETURNING id, url_slug
      `) as DoctorRow[];
      doctor = inserted[0]!;
    }
  } catch (e) {
    return respondError("PIPELINE_FAILED", "doctor insert failed: " + String(e));
  }

  const appUrl = canonicalAppUrl();

  return NextResponse.json({
    ok: true,
    admin: { id: admin.id, email: admin.email },
    doctor: {
      id: doctor.id,
      url_slug: doctor.url_slug,
      pin_hint: body.doctor_pin ? "(set to value you passed)" : "1234 (default)",
      login_url: `${appUrl}/${doctor.url_slug}`,
    },
  });
}
