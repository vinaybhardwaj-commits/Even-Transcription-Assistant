import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASIS = new Set(["initial", "annual_review", "case_review", "vc_observation_pass"]);

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      pr.id::text AS id,
      pr.physician_id::text AS physician_id,
      pr.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      h.name AS hospital_name,
      pr.procedure_or_specialty,
      pr.granted_date,
      pr.basis,
      pr.is_core,
      pr.expires_at,
      gp.email AS granted_by_email,
      pr.withdrawn_date,
      pr.withdrawn_reason,
      pr.created_at
    FROM privileges pr
    JOIN hospitals h ON h.id = pr.hospital_id
    LEFT JOIN profiles gp ON gp.id = pr.granted_by
    WHERE pr.physician_id = ${id}::uuid
    ORDER BY pr.is_core DESC, pr.granted_date DESC
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { hospital_code, procedure_or_specialty, granted_date, basis, is_core, expires_at } = body ?? {};
  if (!hospital_code || !procedure_or_specialty || !granted_date) {
    return NextResponse.json({ ok: false, error: "hospital_code, procedure_or_specialty, granted_date required" }, { status: 400, headers: NO_STORE });
  }
  const finalBasis = basis && BASIS.has(basis) ? basis : "initial";

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const hosp = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
  if (hosp.length === 0) return NextResponse.json({ ok: false, error: `hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });

  // Direct POST to /privileges is the Core path (decision #8: Core = single-step
  // grant). Special privileges should flow through /privilege-requests + a
  // separate approve step. We still accept is_core=false here for callers that
  // genuinely want to bypass the request flow (e.g. /admin tooling, audit
  // restorations) — but body must explicitly say so.
  const finalIsCore = is_core === false ? false : true;
  const inserted = (await sql`
    INSERT INTO privileges (
      physician_id, hospital_id, procedure_or_specialty, granted_date, granted_by, basis, is_core, expires_at
    ) VALUES (
      ${id}::uuid, ${hosp[0].id}::uuid, ${String(procedure_or_specialty).trim()},
      ${granted_date}, ${actor.profileId}::uuid, ${finalBasis}, ${finalIsCore},
      ${typeof expires_at === "string" && expires_at.trim() ? expires_at : null}
    )
    RETURNING id::text AS id, physician_id::text AS physician_id, procedure_or_specialty, granted_date, basis, is_core, expires_at, created_at
  `) as Array<Record<string, unknown>>;

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actor.profileId}::uuid, 'create', 'privilege', ${inserted[0].id as string}, ${JSON.stringify({ ...inserted[0], physician_id: id, hospital_code })}::jsonb)
  `;
  return NextResponse.json({ ok: true, privilege: inserted[0] }, { headers: NO_STORE });
}
