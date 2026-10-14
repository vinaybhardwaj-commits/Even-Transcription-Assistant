import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest, hashPin, isValidPin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/admin/profiles/[id]/reset-pin { pin } — super_admin sets a temp PIN + forces change on next login. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const me = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (me.length === 0 || !me[0].is_super_admin) return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });

  const body = await req.json().catch(() => ({}));
  const pin = String(body?.pin ?? "");
  if (!isValidPin(pin)) return NextResponse.json({ ok: false, error: "pin must be exactly 4 digits" }, { status: 400, headers: NO_STORE });

  const exists = (await sql`SELECT 1 FROM profiles WHERE id = ${id}::uuid LIMIT 1`) as Array<unknown>;
  if (exists.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  const hash = await hashPin(pin);
  await sql`UPDATE profiles SET password_hash = ${hash}, must_change_pin = true, updated_at = NOW() WHERE id = ${id}::uuid`;
  await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (${actor.profileId}::uuid, 'pin_reset', 'profile', ${id}, ${JSON.stringify({ must_change_pin: true })}::jsonb)`;

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
