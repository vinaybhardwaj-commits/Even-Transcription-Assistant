/**
 * POST /api/admin/password
 *
 * Body: { current_password, new_password }
 * Returns: { ok: true }
 *
 * Verifies current_password against admin_user.password_hash via bcrypt.
 * New must be ≥10 chars (rough common-baseline). Updates row + bumps
 * updated_at + last_active_at.
 *
 * No force-rotate per V's lock (self-service only).
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try {
    claims = await verifyAdminJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  let body: { current_password?: string; new_password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const current = typeof body.current_password === "string" ? body.current_password : "";
  const next = typeof body.new_password === "string" ? body.new_password : "";
  if (!current || !next) {
    return respondError("VALIDATION_FAILED", "both_passwords_required");
  }
  if (next.length < 10) {
    return respondError("VALIDATION_FAILED", "new_password_too_short_min_10");
  }
  if (next === current) {
    return respondError("VALIDATION_FAILED", "new_password_must_differ");
  }

  // Load current hash
  let row: { password_hash: string } | undefined;
  try {
    const rows = (await sql`
      SELECT password_hash FROM admin_user WHERE id = ${claims.admin_id}::uuid LIMIT 1
    `) as Array<{ password_hash: string }>;
    row = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!row) return respondError("NOT_FOUND", "admin_not_found");

  const ok = await bcrypt.compare(current, row.password_hash);
  if (!ok) return respondError("PIN_INVALID", "Current password is incorrect");

  const newHash = await bcrypt.hash(next, 12);
  try {
    await sql`
      UPDATE admin_user
         SET password_hash = ${newHash},
             updated_at    = NOW(),
             last_active_at= NOW()
       WHERE id = ${claims.admin_id}::uuid
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  return respondOk({ ok: true });
}
