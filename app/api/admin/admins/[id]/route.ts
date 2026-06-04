/**
 * PATCH /api/admin/admins/{id} — reset another admin's password (all admins are
 * equal, so any valid admin session may do it). Body { password } (>=8). The
 * calling admin types the new password; the server bcrypt-hashes it. Audit-logged.
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "admin sign-in required");
  let actor = "";
  try {
    const c = await verifyAdminJwt(cookie);
    actor = String(c.email ?? c.admin_id ?? "admin");
  } catch {
    return respondError("AUTH_EXPIRED", "session invalid");
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return respondError("VALIDATION_FAILED", "bad_admin_id");

  let body: { password?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) return respondError("VALIDATION_FAILED", "password_min_8_chars");

  const exists = (await sql`SELECT email FROM admin_user WHERE id = ${id}::uuid LIMIT 1`) as Array<{ email: string }>;
  if (!exists[0]) return respondError("NOT_FOUND", "admin_not_found");

  const hash = await bcrypt.hash(password, 12);
  try {
    await sql`UPDATE admin_user SET password_hash = ${hash}, updated_at = NOW() WHERE id = ${id}::uuid`;
  } catch (e) {
    return respondError("PIPELINE_FAILED", (e instanceof Error ? e.message : String(e)).slice(0, 120));
  }

  await sql`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES ('admin', ${actor}, 'admin_user.reset_password', 'admin_user', ${id},
            ${JSON.stringify({ target_email: exists[0].email, by: actor })}::jsonb)
  `.catch(() => { /* intentional: best-effort audit write */ });

  return respondOk({ ok: true, email: exists[0].email });
}
