import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/hospitals-public
 *
 * Unauthenticated. Returns ONLY hospital codes (no internal ids, no metadata)
 * for the /auth/signup form's home-hospital + requested-roles pickers.
 * Codes are public knowledge (printed on letterheads, etc.).
 *
 * Must also be allowlisted in middleware PUBLIC_API_ROUTES.
 */
export async function GET() {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT code FROM hospitals WHERE is_active = true ORDER BY code
  `) as Array<{ code: string }>;
  return NextResponse.json({ ok: true, hospitals: rows.map((r) => ({ code: r.code })) }, { headers: NO_STORE });
}
