/**
 * GET  /api/admin/doctors  — list all doctors (newest first, includes
 *                            soft-deleted with deleted_at populated)
 * POST /api/admin/doctors  — create a new doctor
 *
 * Both gated by eta_admin_session cookie + admin JWT verify.
 *
 * POST body: { full_name, email, phone?, pin? }
 *   - pin defaults to a random 4-digit if omitted
 *   - slug + token auto-generated via lib/doctor-slug.ts
 *   - Returns the plaintext PIN in the response so the admin can
 *     communicate it to the new doctor. (PIN is NOT persisted in
 *     plaintext — only the bcrypt hash lands in pin_hash.)
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt, type AdminClaims } from "@/lib/auth";

type GuardResult =
  | { ok: true; claims: AdminClaims }
  | { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string };
import { buildDoctorSlug } from "@/lib/doctor-slug";
import { respondOk, respondError } from "@/lib/respond";
import bcrypt from "bcryptjs";
import { randomInt } from "crypto";
import { customAlphabet } from "nanoid";

export const runtime = "nodejs";

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

const doctorId = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 8);

async function guard(): Promise<GuardResult> {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    const claims = await verifyAdminJwt(cookie);
    return { ok: true, claims };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

export async function GET() {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  type Row = {
    id: string;
    full_name: string;
    email: string;
    phone: string | null;
    url_slug: string;
    status: "active" | "disabled" | "locked";
    pin_set_at: string | Date | null;
    last_active_at: string | Date | null;
    joined_at: string | Date;
    deleted_at: string | Date | null;
    clinician_type: string | null;
  };
  try {
    const rows = (await sql`
      SELECT d.id, d.full_name, d.email, d.phone, d.url_slug, d.status,
             d.pin_set_at, d.last_active_at, d.joined_at, d.deleted_at,
             d.clinician_type
        FROM clinician d
       ORDER BY d.joined_at DESC
       LIMIT 200
    `) as Row[];
    return respondOk({
      doctors: rows.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        email: r.email,
        phone: r.phone,
        url_slug: r.url_slug,
        status: r.status,
        pin_set_at: r.pin_set_at ? new Date(r.pin_set_at).toISOString() : null,
        last_active_at: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
        joined_at: new Date(r.joined_at).toISOString(),
        deleted: r.deleted_at !== null,
        clinician_type: r.clinician_type ?? "physician",
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}

function generatePin(): string {
  const n = randomInt(0, 10_000); // crypto-strong (B19 P2)
  return String(n).padStart(4, "0");
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { full_name?: string; email?: string; phone?: string; pin?: string; clinician_type?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const fullName = (body.full_name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const phone = body.phone ? body.phone.trim() : null;
  const pin = body.pin && /^[0-9]{4}$/.test(body.pin) ? body.pin : generatePin();
  const clinicianType = ["physician", "dietitian", "physiotherapist"].includes(String(body.clinician_type)) ? String(body.clinician_type) : "physician";

  if (fullName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respondError("VALIDATION_FAILED", "name_and_email_required");
  }

  const built = buildDoctorSlug(fullName);
  const slug = built.full;   // dr-{name}-{4char-token} — what goes into URLs
  const token = built.token; // just the 4-char tail, stored separately
  const pinHash = await bcrypt.hash(pin, 12);
  const id = `doc_${doctorId()}`;

  try {
    await sql`
      INSERT INTO clinician (
        id, legacy_doctor_id, clinician_type, full_name, email, phone, url_slug,
        url_token, pin_hash, pin_plaintext, pin_set_at, status, created_by
      ) VALUES (
        ${id}, NULL, ${clinicianType}::clinician_type, ${fullName}, ${email}, ${phone}, ${slug},
        ${token}, ${pinHash}, ${pin}, NOW(), 'active', ${g.claims.admin_id}
      )
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) {
      return respondError("VALIDATION_FAILED", "email_or_slug_already_exists");
    }
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }


  const appUrl = canonicalAppUrl();
  return respondOk({
    doctor: {
      id,
      full_name: fullName,
      email,
      phone,
      url_slug: slug,
      status: "active",
    },
    pin_plaintext: pin,
    login_url: `${appUrl}/${slug}`,
  });
}
