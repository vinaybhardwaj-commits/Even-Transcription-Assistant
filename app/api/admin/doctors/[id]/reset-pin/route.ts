/**
 * POST /api/admin/doctors/{id}/reset-pin
 *
 * Generates a fresh 4-digit PIN, bcrypts it, replaces pin_hash, resets
 * failed_pin_count + locked_until. Returns the plaintext so the admin
 * can communicate it.
 *
 * Body: {} (optional { pin: "1234" } to set a specific PIN)
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import bcrypt from "bcryptjs";

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

function generatePin(): string {
  const n = Math.floor(Math.random() * 10_000);
  return String(n).padStart(4, "0");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    await verifyAdminJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  if (!id.startsWith("doc_")) {
    return respondError("VALIDATION_FAILED", "bad_doctor_id");
  }

  let body: { pin?: string };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const pin = body.pin && /^[0-9]{4}$/.test(body.pin) ? body.pin : generatePin();
  const pinHash = await bcrypt.hash(pin, 12);

  try {
    const rows = (await sql`
      UPDATE clinician
         SET pin_hash         = ${pinHash},
             pin_plaintext    = ${pin},
             pin_set_at       = NOW(),
             failed_pin_count = 0,
             locked_until     = NULL,
             status           = CASE WHEN status = 'locked' THEN 'active' ELSE status END,
             updated_at       = NOW()
       WHERE id = ${id} AND deleted_at IS NULL
       RETURNING id, url_slug
    `) as { id: string; url_slug: string }[];
    if (rows.length === 0) {
      return respondError("NOT_FOUND", "doctor_not_found");
    }
    const appUrl = canonicalAppUrl();
    return respondOk({
      doctor: { id: rows[0].id, url_slug: rows[0].url_slug },
      pin_plaintext: pin,
      login_url: `${appUrl}/${rows[0].url_slug}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
