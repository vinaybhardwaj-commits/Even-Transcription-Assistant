/**
 * PATCH /api/admin/doctors/{id}
 *
 * Body: { status?, full_name?, email?, phone?, deleted?:boolean }
 * Returns: { doctor: <updated row> }
 *
 * status accepts active|disabled|locked. deleted:true performs a soft
 * delete (deleted_at = NOW()); doctor stops appearing in active lists
 * and PIN entry rejects.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

const ALLOWED_STATUS = new Set(["active", "disabled", "locked"]);

export async function PATCH(
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

  let body: {
    status?: string;
    full_name?: string;
    email?: string;
    phone?: string;
    deleted?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }

  // Build the update piecewise. Neon HTTP template-tag doesn't support
  // dynamic column lists nicely, so we use simple guarded branches.
  try {
    if (body.deleted === true) {
      await sql`UPDATE doctor SET deleted_at = NOW(), status='disabled', updated_at = NOW() WHERE id = ${id}`;
    }
    if (typeof body.status === "string" && ALLOWED_STATUS.has(body.status)) {
      await sql`UPDATE doctor SET status = ${body.status}::doctor_status, updated_at = NOW() WHERE id = ${id} AND deleted_at IS NULL`;
    }
    if (typeof body.full_name === "string" && body.full_name.trim().length >= 2) {
      await sql`UPDATE doctor SET full_name = ${body.full_name.trim()}, updated_at = NOW() WHERE id = ${id} AND deleted_at IS NULL`;
    }
    if (typeof body.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      await sql`UPDATE doctor SET email = ${body.email.trim().toLowerCase()}, updated_at = NOW() WHERE id = ${id} AND deleted_at IS NULL`;
    }
    if (typeof body.phone === "string") {
      await sql`UPDATE doctor SET phone = ${body.phone.trim() || null}, updated_at = NOW() WHERE id = ${id} AND deleted_at IS NULL`;
    }
    const rows = (await sql`
      SELECT id, full_name, email, phone, url_slug, status, deleted_at
        FROM doctor WHERE id = ${id}
    `) as Array<{ id: string; full_name: string; email: string; phone: string | null; url_slug: string; status: string; deleted_at: string | Date | null }>;
    if (rows.length === 0) return respondError("NOT_FOUND", "doctor_not_found");
    const r = rows[0];
    return respondOk({
      doctor: {
        id: r.id, full_name: r.full_name, email: r.email, phone: r.phone,
        url_slug: r.url_slug, status: r.status,
        deleted: r.deleted_at !== null,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) return respondError("VALIDATION_FAILED", "email_already_in_use");
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
