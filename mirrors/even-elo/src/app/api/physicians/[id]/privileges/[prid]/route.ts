import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/physicians/[id]/privileges/[prid]
 *
 * Edit an existing privilege. Accepts:
 *   - is_core           boolean       — convert Core ↔ Special
 *   - expires_at        date | null   — extend/shorten/clear expiry
 *   - withdrawn_date    date | null   — withdraw or restore
 *   - withdrawn_reason  string | null — reason audit
 *
 * Permission: super_admin OR site_medical_head at the privilege's hospital
 * (PRD §C.12 — SMH-at-hospital scope, not network-wide).
 *
 * If is_core flips from false→true, expires_at is cleared (Core privileges
 * don't expire per decision #11). If is_core flips true→false (Core →
 * Special), expires_at defaults to NOW+1yr unless body specifies one.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; prid: string }> }) {
  const { id, prid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(prid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`
    SELECT
      id::text AS id, physician_id::text AS physician_id, hospital_id::text AS hospital_id,
      procedure_or_specialty, granted_date, basis, is_core, expires_at,
      withdrawn_date, withdrawn_reason
    FROM privileges WHERE id = ${prid}::uuid AND physician_id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const b = before[0];

  // Role gate per PRD §C.12 — SMH at this privilege's hospital, or super_admin
  const me = (await sql`
    SELECT
      p.is_super_admin,
      EXISTS (
        SELECT 1 FROM profile_hospital_roles ph
        WHERE ph.profile_id = p.id
          AND ph.role = 'site_medical_head'
          AND ph.hospital_id = ${b.hospital_id as string}::uuid
      ) AS smh_here
    FROM profiles p WHERE p.id = ${actor.profileId}::uuid
  `) as Array<{ is_super_admin: boolean; smh_here: boolean }>;
  if (me.length === 0 || !(me[0].is_super_admin || me[0].smh_here)) {
    return NextResponse.json(
      { ok: false, error: "Requires super_admin or site_medical_head at the privilege's hospital" },
      { status: 403, headers: NO_STORE },
    );
  }

  // Build merged values
  let nextIsCore = body.is_core !== undefined ? Boolean(body.is_core) : (b.is_core as boolean);
  let nextExpires: string | null;
  if (body.expires_at !== undefined) {
    nextExpires = body.expires_at; // may be null to clear
  } else {
    nextExpires = (b.expires_at as string | null) ?? null;
  }
  // is_core type flips trigger expires_at policy
  if (body.is_core !== undefined) {
    if (nextIsCore && body.expires_at === undefined) {
      // Becoming Core — clear expiry (Core doesn't expire)
      nextExpires = null;
    } else if (!nextIsCore && (b.is_core as boolean) === true && body.expires_at === undefined) {
      // Becoming Special — default 1yr if caller didn't set
      const d = new Date(); d.setFullYear(d.getFullYear() + 1);
      nextExpires = d.toISOString().slice(0, 10);
    }
  }

  const merged = {
    is_core: nextIsCore,
    expires_at: nextExpires,
    withdrawn_date: body.withdrawn_date !== undefined ? body.withdrawn_date : b.withdrawn_date,
    withdrawn_reason: body.withdrawn_reason !== undefined ? body.withdrawn_reason : b.withdrawn_reason,
  };

  await sql`
    UPDATE privileges SET
      is_core          = ${merged.is_core},
      expires_at       = ${(merged.expires_at as string | null) ?? null}::date,
      withdrawn_date   = ${(merged.withdrawn_date as string | null) ?? null}::date,
      withdrawn_reason = ${(merged.withdrawn_reason as string | null) ?? null}
    WHERE id = ${prid}::uuid
  `;
  const after = (await sql`
    SELECT
      id::text AS id, physician_id::text AS physician_id,
      procedure_or_specialty, is_core, expires_at, withdrawn_date, withdrawn_reason
    FROM privileges WHERE id = ${prid}::uuid
  `) as Array<Record<string, unknown>>;

  // Pick a meaningful action label for the audit row
  let action = "update";
  if (body.withdrawn_date && !b.withdrawn_date) action = "withdraw";
  else if (b.withdrawn_date && (body.withdrawn_date === null)) action = "restore";
  else if (body.is_core !== undefined && body.is_core !== b.is_core) action = nextIsCore ? "convert_to_core" : "convert_to_special";
  else if (body.expires_at !== undefined && body.expires_at !== b.expires_at) action = "edit_expiry";

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${action},
      'privilege',
      ${prid},
      ${JSON.stringify(b)}::jsonb,
      ${JSON.stringify({ ...after[0], physician_id: id })}::jsonb
    )
  `;
  return NextResponse.json({ ok: true, privilege: after[0] }, { headers: NO_STORE });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; prid: string }> }) {
  const { id, prid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(prid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Lookup hospital for role gate
  const before = (await sql`
    SELECT id::text AS id, hospital_id::text AS hospital_id, procedure_or_specialty
    FROM privileges WHERE id = ${prid}::uuid AND physician_id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  // DELETE remains super_admin-only — it's a hard delete that loses audit linkage
  const me = (await sql`SELECT is_super_admin FROM profiles WHERE id = ${actor.profileId}::uuid`) as Array<{ is_super_admin: boolean }>;
  if (me.length === 0 || !me[0].is_super_admin) {
    return NextResponse.json({ ok: false, error: "Hard delete is super_admin only — use withdraw via PATCH instead" }, { status: 403, headers: NO_STORE });
  }

  await sql`DELETE FROM privileges WHERE id = ${prid}::uuid`;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json)
    VALUES (${actor.profileId}::uuid, 'delete', 'privilege', ${prid}, ${JSON.stringify({ ...before[0], physician_id: id })}::jsonb)
  `;
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
