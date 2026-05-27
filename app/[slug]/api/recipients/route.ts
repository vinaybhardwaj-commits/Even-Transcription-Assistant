/**
 * GET  /{slug}/api/recipients — list this doctor's saved contacts
 * POST /{slug}/api/recipients — add a new contact
 *
 * Lives under /{slug} so the doctor cookie reaches it (Path scope from
 * Sprint 1.F.1.H1). recipient_per_doctor has unique (doctor_id, email)
 * implicitly via app behavior.
 *
 * Body (POST): { email, name, role? }   role ∈ admin|records|finance|compliance|other
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

const ROLES = new Set(["admin", "records", "finance", "compliance", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type GuardOk = { ok: true; doctorId: string };
type GuardFail = { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED" | "FORBIDDEN"; msg: string };

async function guard(slug: string): Promise<GuardOk | GuardFail> {
  const cookie = await readDoctorCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    const claims = await verifyDoctorJwt(cookie);
    if (claims.slug !== slug) return { ok: false, code: "FORBIDDEN", msg: "Slug mismatch" };
    return { ok: true, doctorId: claims.doctor_id };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const g = await guard(slug);
  if (!g.ok) return respondError(g.code, g.msg);

  type Row = {
    id: string;
    email: string;
    name: string;
    role: string;
    set_by: string;
    created_at: string | Date;
  };
  try {
    const rows = (await sql`
      SELECT id, email, name, role, set_by, created_at
        FROM recipient_per_doctor
       WHERE doctor_id = ${g.doctorId}
       ORDER BY name ASC
    `) as Row[];
    return respondOk({
      recipients: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        set_by: r.set_by,
        created_at: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const g = await guard(slug);
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { email?: string; name?: string; role?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = typeof body.role === "string" && ROLES.has(body.role) ? body.role : "other";
  if (!EMAIL_RE.test(email)) return respondError("VALIDATION_FAILED", "bad_email");
  if (name.length < 1) return respondError("VALIDATION_FAILED", "name_required");

  try {
    const rows = (await sql`
      INSERT INTO recipient_per_doctor (doctor_id, email, name, role, set_by)
      VALUES (${g.doctorId}, ${email}, ${name.slice(0, 200)}, ${role}::recipient_role, 'doctor')
      RETURNING id, email, name, role, set_by, created_at
    `) as Array<{
      id: string; email: string; name: string; role: string; set_by: string;
      created_at: string | Date;
    }>;
    const r = rows[0]!;
    return respondOk({
      recipient: {
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        set_by: r.set_by,
        created_at: new Date(r.created_at).toISOString(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) return respondError("VALIDATION_FAILED", "email_already_in_list");
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
