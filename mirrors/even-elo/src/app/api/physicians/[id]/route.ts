import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT
      id::text AS id, full_name, preferred_name, primary_specialty,
      registration_number, registration_council, registration_expiry,
      indemnity_expiry, docs_external_url,
      email, phone, date_joined_network, current_status, notes,
      portal_access,
      created_at, updated_at
    FROM physicians WHERE id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  const engagements = (await sql`
    SELECT
      e.id::text AS id,
      e.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      h.name AS hospital_name,
      e.category,
      e.start_date,
      e.end_date,
      e.specialty,
      e.status,
      e.status_reason
    FROM physician_engagements e
    JOIN hospitals h ON h.id = e.hospital_id
    WHERE e.physician_id = ${id}::uuid
    ORDER BY e.start_date DESC
  `) as Array<Record<string, unknown>>;

  // CR.2: graduation_ready_engagement_ids — list of engagement ids where
  // category='provisional' AND start_date <= NOW()-6mo AND there's a
  // satisfactory FPPE (onboarded vc_prescreens row) at the same hospital.
  // SMH/super_admin sees the "Graduate to Active" CTA against these.
  const gradReady = (await sql`
    SELECT e.id::text AS id
    FROM physician_engagements e
    WHERE e.physician_id = ${id}::uuid
      AND e.category = 'provisional'
      AND e.status = 'active'
      AND e.start_date <= (CURRENT_DATE - INTERVAL '6 months')
      AND EXISTS (
        SELECT 1 FROM vc_prescreens v
        WHERE v.physician_id = ${id}::uuid
          AND v.hospital_id = e.hospital_id
          AND v.stage = 'onboarded'
      )
  `) as Array<{ id: string }>;
  const graduation_ready_engagement_ids = gradReady.map((r) => r.id);

  return NextResponse.json(
    { ok: true, physician: rows[0], engagements, graduation_ready_engagement_ids },
    { headers: NO_STORE },
  );
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try {
    actor = await actorFromRequest();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  }
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });

  const body = await req.json();
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`SELECT * FROM physicians WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  const allowed = [
    "full_name", "preferred_name", "primary_specialty",
    "registration_number", "registration_council", "registration_expiry",
    "indemnity_expiry", "docs_external_url",
    "email", "phone", "date_joined_network", "current_status", "notes",
  ];
  // Build a single UPDATE — only set keys present in body
  // We use a series of COALESCE updates for simplicity.
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) updates[k] = body[k] ?? null;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: "no fields to update" }, { status: 400, headers: NO_STORE });
  }

  // Merge before-state with updates so unmentioned fields keep their value.
  const b = before[0] as Record<string, unknown>;
  const merged = { ...b, ...updates };
  await sql`
    UPDATE physicians SET
      full_name            = ${merged.full_name as string},
      preferred_name       = ${(merged.preferred_name as string | null) ?? null},
      primary_specialty    = ${(merged.primary_specialty as string | null) ?? null},
      registration_number  = ${(merged.registration_number as string | null) ?? null},
      registration_council = ${(merged.registration_council as string | null) ?? null},
      registration_expiry  = ${(merged.registration_expiry as string | null) ?? null},
      indemnity_expiry     = ${(merged.indemnity_expiry as string | null) ?? null},
      docs_external_url    = ${(merged.docs_external_url as string | null) ?? null},
      email                = ${(merged.email as string | null) ?? null},
      phone                = ${(merged.phone as string | null) ?? null},
      date_joined_network  = ${(merged.date_joined_network as string | null) ?? null},
      current_status       = ${merged.current_status as string},
      notes                = ${(merged.notes as string | null) ?? null},
      updated_at           = NOW()
    WHERE id = ${id}::uuid
  `;
  const after = (await sql`SELECT * FROM physicians WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (${actor.profileId}::uuid, 'update', 'physician', ${id}, ${JSON.stringify(before[0])}::jsonb, ${JSON.stringify(after[0])}::jsonb)
  `;
  return NextResponse.json({ ok: true, physician: after[0] }, { headers: NO_STORE });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`SELECT * FROM physicians WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  await sql`UPDATE physicians SET current_status = 'terminated', updated_at = NOW() WHERE id = ${id}::uuid`;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (${actor.profileId}::uuid, 'delete', 'physician', ${id}, ${JSON.stringify(before[0])}::jsonb, ${JSON.stringify({ current_status: 'terminated' })}::jsonb)
  `;
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
