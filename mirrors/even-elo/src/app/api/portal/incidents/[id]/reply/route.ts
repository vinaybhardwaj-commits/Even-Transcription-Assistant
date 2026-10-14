import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/portal/incidents/[id]/reply — physician responds to feedback about THEM (#7). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return portalJson({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const { reply_text } = (await req.json().catch(() => ({}))) as { reply_text?: string };
  if (!reply_text || !reply_text.trim()) return portalJson({ ok: false, error: "reply_text required" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const inc = (await sql`SELECT target_physician_id::text AS target FROM incidents WHERE id = ${id}::uuid LIMIT 1`) as Array<{ target: string }>;
  if (inc.length === 0) return portalJson({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  if (inc[0].target !== me.physicianId) return portalJson({ ok: false, error: "You can only reply to feedback about you." }, { status: 403, headers: NO_STORE });

  await sql`INSERT INTO incident_replies (incident_id, replied_by_physician_id, reply_text) VALUES (${id}::uuid, ${me.physicianId}::uuid, ${reply_text.trim()})`;
  await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json) VALUES ('reply', 'incident', ${id}, ${JSON.stringify({ via: "portal", by_physician: me.physicianId })}::jsonb)`;
  return portalJson({ ok: true }, { headers: NO_STORE });
}
