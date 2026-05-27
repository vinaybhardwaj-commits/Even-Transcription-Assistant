/**
 * PATCH  /api/admin/recipients/{id} — update name/email/role/active
 * DELETE /api/admin/recipients/{id} — remove from the global list
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

const ROLES = new Set(["admin", "records", "finance", "compliance", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function guard() {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false as const, code: "AUTH_REQUIRED" as const, msg: "Sign in required" };
  try {
    await verifyAdminJwt(cookie);
    return { ok: true as const };
  } catch {
    return { ok: false as const, code: "AUTH_EXPIRED" as const, msg: "Session invalid" };
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { email?: string; name?: string; role?: string; active?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  try {
    if (typeof body.email === "string" && EMAIL_RE.test(body.email)) {
      await sql`UPDATE recipient_global SET email = ${body.email.trim().toLowerCase()}, updated_at = NOW() WHERE id = ${id}::uuid`;
    }
    if (typeof body.name === "string" && body.name.trim().length > 0) {
      await sql`UPDATE recipient_global SET name = ${body.name.trim().slice(0, 200)}, updated_at = NOW() WHERE id = ${id}::uuid`;
    }
    if (typeof body.role === "string" && ROLES.has(body.role)) {
      await sql`UPDATE recipient_global SET role = ${body.role}::recipient_role, updated_at = NOW() WHERE id = ${id}::uuid`;
    }
    if (typeof body.active === "boolean") {
      await sql`UPDATE recipient_global SET active = ${body.active}, updated_at = NOW() WHERE id = ${id}::uuid`;
    }
    const rows = (await sql`
      SELECT id, email, name, role, active, created_at
        FROM recipient_global WHERE id = ${id}::uuid
    `) as Array<{ id: string; email: string; name: string; role: string; active: boolean; created_at: string | Date }>;
    if (rows.length === 0) return respondError("NOT_FOUND", "recipient_not_found");
    const r = rows[0]!;
    return respondOk({
      recipient: {
        id: r.id, email: r.email, name: r.name, role: r.role, active: r.active,
        created_at: new Date(r.created_at).toISOString(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) return respondError("VALIDATION_FAILED", "email_already_in_global_list");
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);
  try {
    const rows = (await sql`DELETE FROM recipient_global WHERE id = ${id}::uuid RETURNING id`) as Array<{ id: string }>;
    if (rows.length === 0) return respondError("NOT_FOUND", "recipient_not_found");
    return respondOk({ ok: true, id: rows[0]!.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
