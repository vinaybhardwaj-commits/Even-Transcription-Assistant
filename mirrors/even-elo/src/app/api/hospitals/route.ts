import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/hospitals
 *
 * Returns the active hospital catalogue for filter dropdowns (v3.0b TopNav).
 * Auth required (any logged-in user).
 */
export async function GET() {
  try {
    await actorFromRequest();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT id::text AS id, code, name, is_active
    FROM hospitals
    WHERE is_active = true
    ORDER BY code
  `) as Array<{ id: string; code: string; name: string; is_active: boolean }>;
  return NextResponse.json({ ok: true, hospitals: rows }, { headers: NO_STORE });
}
