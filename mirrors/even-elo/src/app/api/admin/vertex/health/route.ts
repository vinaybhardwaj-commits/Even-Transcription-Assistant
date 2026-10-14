import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { runVertexHealthCheck } from "@/lib/vertex/client";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/admin/vertex/health
 *
 * Super-admin only, same gate as other /api/admin handlers: active session
 * via middleware, then profiles_with_roles.is_super_admin. No prompt input.
 * Response states: not_configured | flag_off | ok | error.
 * Never returns the service-account email, private key, PHI, or model text.
 * Preview and local without SA secrets return not_configured and do not call Vertex.
 */
export async function GET() {
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const me = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (me.length === 0 || !me[0].is_super_admin) {
    return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });
  }

  const body = await runVertexHealthCheck();
  return NextResponse.json(body, { headers: NO_STORE });
}
