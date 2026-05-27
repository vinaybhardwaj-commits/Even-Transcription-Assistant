/**
 * GET  /api/admin/recipients — list global recipients (admin-managed,
 *   shared across all doctors)
 * POST /api/admin/recipients — add one
 *
 * Cookie-gated to admin role. Path=/ via H2 fix.
 *
 * Body (POST): { email, name, role, active? }
 *   role ∈ admin|records|finance|compliance|other
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt, type AdminClaims } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

const ROLES = new Set(["admin", "records", "finance", "compliance", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type GuardOk = { ok: true; claims: AdminClaims };
type GuardFail = { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string };

async function guard(): Promise<GuardOk | GuardFail> {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    const claims = await verifyAdminJwt(cookie);
    return { ok: true, claims };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

export async function GET() {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  type Row = {
    id: string;
    email: string;
    name: string;
    role: string;
    active: boolean;
    created_at: string | Date;
  };
  try {
    const rows = (await sql`
      SELECT id, email, name, role, active, created_at
        FROM recipient_global
       ORDER BY active DESC, name ASC
    `) as Row[];
    return respondOk({
      recipients: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        active: r.active,
        created_at: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { email?: string; name?: string; role?: string; active?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = typeof body.role === "string" && ROLES.has(body.role) ? body.role : "records";
  const active = body.active !== false;
  if (!EMAIL_RE.test(email)) return respondError("VALIDATION_FAILED", "bad_email");
  if (name.length < 1) return respondError("VALIDATION_FAILED", "name_required");

  try {
    const rows = (await sql`
      INSERT INTO recipient_global (email, name, role, active, created_by)
      VALUES (${email}, ${name.slice(0, 200)}, ${role}::recipient_role, ${active}, ${g.claims.admin_id}::uuid)
      RETURNING id, email, name, role, active, created_at
    `) as Array<{
      id: string; email: string; name: string; role: string; active: boolean;
      created_at: string | Date;
    }>;
    const r = rows[0]!;
    return respondOk({
      recipient: {
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        active: r.active,
        created_at: new Date(r.created_at).toISOString(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) return respondError("VALIDATION_FAILED", "email_already_in_global_list");
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
