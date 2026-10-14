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
 * POST /api/incidents/[id]/view
 *
 * Marks the incident as reviewed by the current user. Idempotent.
 * Used by the manual 'Mark reviewed' button as a fallback to
 * auto-on-open-page behaviour. Same INSERT as the GET-driven path,
 * just tagged via='mark_reviewed' in the row + audit log.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  await sql`
    INSERT INTO incident_views (incident_id, profile_id, via)
    VALUES (${id}::uuid, ${actor.profileId}::uuid, 'mark_reviewed')
    ON CONFLICT (incident_id, profile_id) DO UPDATE SET via = 'mark_reviewed', viewed_at = now()
  `;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actor.profileId}::uuid, 'mark_reviewed', 'incident', ${id}, ${JSON.stringify({ via: "mark_reviewed" })}::jsonb)
  `;
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
