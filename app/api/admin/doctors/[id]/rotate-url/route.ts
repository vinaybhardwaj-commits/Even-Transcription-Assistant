/**
 * POST /api/admin/doctors/{id}/rotate-url
 *
 * Generates a new 4-char URL token, updates the doctor's url_token AND
 * url_slug (which has the token appended), and writes an audit_log row.
 * The old URL stops working immediately on next page load — V should
 * email the new URL to the doctor (use /email-url endpoint).
 *
 * Returns: { doctor: { url_slug, url_token, login_url } }
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { generateToken } from "@/lib/doctor-slug";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

function canonicalAppUrl(): string {
  const raw = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw || /eta\.even\.in/i.test(raw)) return "https://evenscribe.app";
  return raw;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    adminId = String(claims.admin_id ?? "");
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  const { id } = await params;
  if (!id.startsWith("doc_")) return respondError("VALIDATION_FAILED", "bad_doctor_id");

  // Load current url_slug to derive the base (everything before the last '-XXXX' suffix).
  try {
    const rows = (await sql`
      SELECT id, url_slug, url_token FROM clinician
       WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Array<{ id: string; url_slug: string; url_token: string }>;
    if (rows.length === 0) return respondError("NOT_FOUND", "doctor_not_found");
    const old = rows[0]!;

    // Derive base by stripping the trailing '-{old_token}' suffix.
    const suffix = `-${old.url_token}`;
    const base = old.url_slug.endsWith(suffix)
      ? old.url_slug.slice(0, -suffix.length)
      : old.url_slug.replace(/-[a-z2-9]{4}$/, "");
    const newToken = generateToken(4);
    const newSlug = `${base}-${newToken}`;

    await sql`
      UPDATE clinician
         SET url_slug  = ${newSlug},
             url_token = ${newToken},
             updated_at = NOW()
       WHERE id = ${id} AND deleted_at IS NULL
    `;
    await sql`
      INSERT INTO audit_log
        (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES
        ('admin', ${adminId}, 'doctor.rotate_url_token', 'doctor', ${id},
         ${JSON.stringify({ old_token: old.url_token, new_token: newToken })}::jsonb)
    `;
    const loginUrl = `${canonicalAppUrl()}/${newSlug}`;
    return respondOk({
      doctor: { id, url_slug: newSlug, url_token: newToken, login_url: loginUrl },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) return respondError("PIPELINE_FAILED", "slug_collision_retry");
    return respondError("PIPELINE_FAILED", msg.slice(0, 200));
  }
}
