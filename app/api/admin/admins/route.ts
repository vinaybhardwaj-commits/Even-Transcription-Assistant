/**
 * /api/admin/admins — list + create admin users (all admins are equal:
 * role='super'; a valid admin session is the only gate). Replaces the
 * unauthenticated hard-coded seed-team route for adding teammates.
 *
 * GET  -> { admins: [{ id, email, name, role, last_active_at, created_at }] }
 * POST -> body { email, name, password } -> creates a super admin.
 *         The CALLING admin enters the password; the server bcrypt-hashes it.
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAdmin(): Promise<{ id: string; email: string } | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return { id: String(c.admin_id ?? c.sub ?? ""), email: String(c.email ?? "") };
  } catch {
    return null;
  }
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return respondError("AUTH_REQUIRED", "admin sign-in required");
  const rows = (await sql`
    SELECT id, email, name, role, last_active_at, created_at
      FROM admin_user ORDER BY created_at ASC
  `) as Array<Record<string, unknown>>;
  return respondOk({ admins: rows });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return respondError("AUTH_REQUIRED", "admin sign-in required");

  let body: { email?: unknown; name?: unknown; password?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !EMAIL_RE.test(email)) return respondError("VALIDATION_FAILED", "valid_email_required");
  if (!name) return respondError("VALIDATION_FAILED", "name_required");
  if (password.length < 8) return respondError("VALIDATION_FAILED", "password_min_8_chars");

  // Friendly duplicate check (email is a CITEXT UNIQUE column).
  const existing = (await sql`SELECT id FROM admin_user WHERE email = ${email} LIMIT 1`) as Array<{ id: string }>;
  if (existing[0]) return respondError("VALIDATION_FAILED", "email_already_an_admin");

  const passwordHash = await bcrypt.hash(password, 12);

  let created: { id: string; email: string; name: string; role: string } | undefined;
  try {
    const rows = (await sql`
      INSERT INTO admin_user (email, name, password_hash, role)
      VALUES (${email}, ${name}, ${passwordHash}, 'super')
      RETURNING id, email, name, role
    `) as Array<{ id: string; email: string; name: string; role: string }>;
    created = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", `create_failed: ${msg.slice(0, 120)}`);
  }
  if (!created) return respondError("PIPELINE_FAILED", "insert_returned_no_row");

  await sql`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES ('admin', ${admin.id || admin.email || "admin"}, 'admin_user.create', 'admin_user', ${created.id},
            ${JSON.stringify({ email, name, role: "super", created_by: admin.email })}::jsonb)
  `.catch(() => { /* intentional: best-effort audit write */ });

  return respondOk({ admin: created });
}
