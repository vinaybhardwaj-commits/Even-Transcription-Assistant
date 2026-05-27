/**
 * PATCH  /{slug}/api/recipients/{id} — update name/email/role
 * DELETE /{slug}/api/recipients/{id} — remove
 *
 * Ownership: the row's doctor_id must match the JWT's doctor_id.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

const ROLES = new Set(["admin", "records", "finance", "compliance", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Ok = { ok: true; doctorId: string };
type Fail = { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED" | "FORBIDDEN"; msg: string };

async function guard(slug: string): Promise<Ok | Fail> {
  const cookie = await readDoctorCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    const c = await verifyDoctorJwt(cookie);
    if (c.slug !== slug) return { ok: false, code: "FORBIDDEN", msg: "Slug mismatch" };
    return { ok: true, doctorId: c.doctor_id };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const g = await guard(slug);
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { email?: string; name?: string; role?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }

  try {
    if (typeof body.email === "string" && EMAIL_RE.test(body.email)) {
      await sql`UPDATE recipient_per_doctor SET email = ${body.email.trim().toLowerCase()}, updated_at = NOW() WHERE id = ${id}::uuid AND doctor_id = ${g.doctorId}`;
    }
    if (typeof body.name === "string" && body.name.trim().length > 0) {
      await sql`UPDATE recipient_per_doctor SET name = ${body.name.trim().slice(0, 200)}, updated_at = NOW() WHERE id = ${id}::uuid AND doctor_id = ${g.doctorId}`;
    }
    if (typeof body.role === "string" && ROLES.has(body.role)) {
      await sql`UPDATE recipient_per_doctor SET role = ${body.role}::recipient_role, updated_at = NOW() WHERE id = ${id}::uuid AND doctor_id = ${g.doctorId}`;
    }
    const rows = (await sql`
      SELECT id, email, name, role, set_by, created_at
        FROM recipient_per_doctor
       WHERE id = ${id}::uuid AND doctor_id = ${g.doctorId}
    `) as Array<{ id: string; email: string; name: string; role: string; set_by: string; created_at: string | Date }>;
    if (rows.length === 0) return respondError("NOT_FOUND", "recipient_not_found");
    const r = rows[0]!;
    return respondOk({
      recipient: {
        id: r.id, email: r.email, name: r.name, role: r.role, set_by: r.set_by,
        created_at: new Date(r.created_at).toISOString(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) return respondError("VALIDATION_FAILED", "email_already_in_list");
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const g = await guard(slug);
  if (!g.ok) return respondError(g.code, g.msg);
  try {
    const rows = (await sql`
      DELETE FROM recipient_per_doctor
       WHERE id = ${id}::uuid AND doctor_id = ${g.doctorId}
       RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) return respondError("NOT_FOUND", "recipient_not_found");
    return respondOk({ ok: true, id: rows[0]!.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
