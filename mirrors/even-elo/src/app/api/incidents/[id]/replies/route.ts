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
 * POST /api/incidents/[id]/replies
 *
 * Right-of-reply per locked decision #24 — unlimited, no character cap,
 * no moderator review. Only the target physician can post (email match
 * against physicians.email). Audited.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const text = typeof body?.reply_text === "string" ? body.reply_text.trim() : "";
  if (!text) return NextResponse.json({ ok: false, error: "reply_text required" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const inc = (await sql`
    SELECT i.target_physician_id::text AS target_physician_id, ph.email AS target_email, i.status
    FROM incidents i JOIN physicians ph ON ph.id = i.target_physician_id
    WHERE i.id = ${id}::uuid
  `) as Array<{ target_physician_id: string; target_email: string | null; status: string }>;
  if (inc.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  if (inc[0].status === "retracted") {
    return NextResponse.json({ ok: false, error: "cannot reply on a retracted incident" }, { status: 409, headers: NO_STORE });
  }
  const targetEmail = (inc[0].target_email ?? "").toLowerCase();
  if (!targetEmail || targetEmail !== actor.email.toLowerCase()) {
    return NextResponse.json({ ok: false, error: "Only the target physician can reply" }, { status: 403, headers: NO_STORE });
  }

  const inserted = (await sql`
    INSERT INTO incident_replies (incident_id, replied_by_profile_id, reply_text)
    VALUES (${id}::uuid, ${actor.profileId}::uuid, ${text})
    RETURNING id::text AS id, reply_text, replied_at
  `) as Array<Record<string, unknown>>;

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      'reply',
      'incident',
      ${id},
      ${JSON.stringify({
        physician_id: inc[0].target_physician_id,
        reply_id: inserted[0].id,
        reply_excerpt: text.slice(0, 240),
      })}::jsonb
    )
  `;
  return NextResponse.json({ ok: true, reply: inserted[0] }, { headers: NO_STORE });
}
