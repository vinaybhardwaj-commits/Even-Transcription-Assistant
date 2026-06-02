/**
 * POST /api/admin/login
 *
 * Body: { email, password }
 * Returns: { admin: {id, email, name, role} } + sets eta_admin_session cookie
 *
 * Verifies bcrypt password against admin_user.password_hash. On
 * success, signs an admin JWT (audience='admin') and sets the
 * eta_admin_session cookie (Path=/admin, HttpOnly, Secure, SameSite=
 * strict, 30d). Updates last_active_at.
 *
 * Wrong-password failure returns 401 with the standard error envelope
 * but does NOT distinguish 'no such admin' from 'wrong password' —
 * same response either way to prevent email enumeration.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { signAdminJwt } from "@/lib/auth";
import { setAdminCookie } from "@/lib/cookie";
import { respondOk, respondError } from "@/lib/respond";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

type AdminRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: "super" | "ops" | "viewer";
};

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password || password.length < 4) {
    return respondError("VALIDATION_FAILED", "email_and_password_required");
  }

  let row: AdminRow | undefined;
  try {
    const rows = (await sql`
      SELECT id, email, name, password_hash, role
        FROM admin_user
       WHERE email = ${email}
       LIMIT 1
    `) as AdminRow[];
    row = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!row) {
    // Deliberate constant-time-ish delay so timing doesn't leak existence
    await bcrypt.compare(password, "$2a$12$0000000000000000000000.0000000000000000000000000000000");
    return respondError("PIN_INVALID", "Invalid email or password");
  }
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    return respondError("PIN_INVALID", "Invalid email or password");
  }

  // Update last_active
  await sql`UPDATE admin_user SET last_active_at = NOW() WHERE id = ${row.id}`.catch(() => { /* intentional: best-effort last_active_at touch */ });

  // Sign + set cookie
  const jwt = await signAdminJwt({ admin_id: row.id, email: row.email });
  await setAdminCookie(jwt);

  return respondOk({
    admin: { id: row.id, email: row.email, name: row.name, role: row.role },
  });
}
