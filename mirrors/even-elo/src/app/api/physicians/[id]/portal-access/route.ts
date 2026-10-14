import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { hashPortalPin, isValidPin } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/physicians/[id]/portal-access { enabled, pin? } — admin enables/disables portal access or resets the temp PIN. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const me = (await sql`SELECT is_super_admin, is_site_medical_head, is_hr FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean; is_site_medical_head: boolean; is_hr: boolean }>;
  if (me.length === 0 || !(me[0].is_super_admin || me[0].is_site_medical_head || me[0].is_hr)) {
    return NextResponse.json({ ok: false, error: "Not permitted" }, { status: 403, headers: NO_STORE });
  }

  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean; pin?: string; permanent?: boolean };
  const phys = (await sql`SELECT id::text AS id, email, portal_access FROM physicians WHERE id = ${id}::uuid LIMIT 1`) as Array<{ id: string; email: string | null; portal_access: boolean }>;
  if (phys.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  if (body.enabled === false) {
    await sql`UPDATE physicians SET portal_access = false, updated_at = NOW() WHERE id = ${id}::uuid`;
    await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json) VALUES (${actor.profileId}::uuid, 'portal_disable', 'physician', ${id}, ${JSON.stringify({ portal_access: false })}::jsonb)`;
    return NextResponse.json({ ok: true, portal_access: false }, { headers: NO_STORE });
  }

  // enable OR reset PIN — require a 4-digit pin + an email (login identity)
  if (!phys[0].email) return NextResponse.json({ ok: false, error: "Physician has no email — needed as the portal login identity." }, { status: 400, headers: NO_STORE });
  const pin = String(body.pin ?? "");
  if (!isValidPin(pin)) return NextResponse.json({ ok: false, error: "pin must be exactly 4 digits" }, { status: 400, headers: NO_STORE });
  const hash = await hashPortalPin(pin);
  const mustChange = body.permanent === true ? false : true;
  await sql`UPDATE physicians SET portal_access = true, portal_pin_hash = ${hash}, portal_must_change_pin = ${mustChange}, updated_at = NOW() WHERE id = ${id}::uuid`;
  await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json) VALUES (${actor.profileId}::uuid, 'portal_enable', 'physician', ${id}, ${JSON.stringify({ portal_access: true, must_change_pin: mustChange })}::jsonb)`;
  return NextResponse.json({ ok: true, portal_access: true }, { headers: NO_STORE });
}
