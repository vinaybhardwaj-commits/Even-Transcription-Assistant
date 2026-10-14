import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(["site_medical_head", "hr", "sgc_member"]);

/**
 * GET /api/admin/profiles/[id]/roles  → returns active rows for the profile
 * POST /api/admin/profiles/[id]/roles { hospital_code, role, granted: bool }
 *   - granted=true → INSERT ON CONFLICT DO NOTHING
 *   - granted=false → DELETE
 *
 * Used by the v3.0c inline-expand 4×3 grid on /admin/users.
 */
async function ensureActor() {
  try { return await actorFromRequest(); } catch { return null; }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await ensureActor();
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const meSuper = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (meSuper.length === 0 || !meSuper[0].is_super_admin) return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });
  const rows = (await sql`
    SELECT
      r.role,
      h.code AS hospital_code,
      h.id::text AS hospital_id,
      r.granted_at
    FROM profile_hospital_roles r
    JOIN hospitals h ON h.id = r.hospital_id
    WHERE r.profile_id = ${id}::uuid
    ORDER BY h.code, r.role
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, roles: rows }, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await ensureActor();
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  const body = await req.json().catch(() => ({}));
  const hospital_code = String(body?.hospital_code ?? "").trim().toUpperCase();
  const role = String(body?.role ?? "").trim();
  const granted = Boolean(body?.granted);
  if (!hospital_code) return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
  if (!VALID_ROLES.has(role)) return NextResponse.json({ ok: false, error: "role must be site_medical_head | hr | sgc_member" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const meSuper = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (meSuper.length === 0 || !meSuper[0].is_super_admin) return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });

  const h = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
  if (h.length === 0) return NextResponse.json({ ok: false, error: `Unknown hospital ${hospital_code}` }, { status: 400, headers: NO_STORE });
  const hospital_id = h[0].id;

  if (granted) {
    await sql`
      INSERT INTO profile_hospital_roles (profile_id, hospital_id, role, granted_by)
      VALUES (${id}::uuid, ${hospital_id}::uuid, ${role}, ${actor.profileId}::uuid)
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
      VALUES (${actor.profileId}::uuid, 'grant_role', 'profile_hospital_role', ${id}, ${JSON.stringify({ hospital_code, role })}::jsonb)
    `;
  } else {
    await sql`
      DELETE FROM profile_hospital_roles
      WHERE profile_id = ${id}::uuid AND hospital_id = ${hospital_id}::uuid AND role = ${role}
    `;
    await sql`
      INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json)
      VALUES (${actor.profileId}::uuid, 'revoke_role', 'profile_hospital_role', ${id}, ${JSON.stringify({ hospital_code, role })}::jsonb)
    `;
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
