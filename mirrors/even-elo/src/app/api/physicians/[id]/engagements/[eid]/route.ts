import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENGAGEMENT_STATUSES = new Set([
  "active",
  "suspended",
  "revoked",
  "resigned",
  "lapsed",
]);
const ENGAGEMENT_CATEGORIES = new Set([
  "provisional",
  "active",
  "visiting_consultant",
  "locum_tenens",
  "affiliate",
]);

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(eid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`SELECT * FROM physician_engagements WHERE id = ${eid}::uuid AND physician_id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const b = before[0];

  if (body.status !== undefined && !ENGAGEMENT_STATUSES.has(body.status)) {
    return NextResponse.json({ ok: false, error: "status must be one of: active|suspended|revoked|resigned|lapsed" }, { status: 400, headers: NO_STORE });
  }
  if (body.category !== undefined && !ENGAGEMENT_CATEGORIES.has(body.category)) {
    return NextResponse.json({ ok: false, error: "category must be one of: provisional|active|visiting_consultant|locum_tenens|affiliate" }, { status: 400, headers: NO_STORE });
  }

  // Legacy compatibility: callers may still send terminated_reason — map to status_reason.
  const incomingStatusReason =
    body.status_reason !== undefined ? body.status_reason :
    body.terminated_reason !== undefined ? body.terminated_reason : undefined;

  const merged = {
    end_date: body.end_date !== undefined ? body.end_date : b.end_date,
    specialty: body.specialty !== undefined ? body.specialty : b.specialty,
    status: body.status ?? b.status,
    status_reason: incomingStatusReason !== undefined ? incomingStatusReason : b.status_reason,
    category: body.category ?? b.category,
  };

  await sql`
    UPDATE physician_engagements SET
      end_date      = ${(merged.end_date as string | null) ?? null},
      specialty     = ${(merged.specialty as string | null) ?? null},
      status        = ${merged.status as string},
      status_reason = ${(merged.status_reason as string | null) ?? null},
      category      = ${merged.category as string}
    WHERE id = ${eid}::uuid
  `;

  const after = (await sql`SELECT * FROM physician_engagements WHERE id = ${eid}::uuid`) as Array<Record<string, unknown>>;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (${actor.profileId}::uuid, 'update', 'engagement', ${eid}, ${JSON.stringify(b)}::jsonb, ${JSON.stringify(after[0])}::jsonb)
  `;
  return NextResponse.json({ ok: true, engagement: after[0] }, { headers: NO_STORE });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(eid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`SELECT * FROM physician_engagements WHERE id = ${eid}::uuid AND physician_id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  await sql`DELETE FROM physician_engagements WHERE id = ${eid}::uuid`;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json)
    VALUES (${actor.profileId}::uuid, 'delete', 'engagement', ${eid}, ${JSON.stringify(before[0])}::jsonb)
  `;
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
