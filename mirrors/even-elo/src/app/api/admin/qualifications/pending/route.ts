import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/admin/qualifications/pending — every unverified qualification across
 * the network, newest first, joined to the owning physician. Any authenticated
 * governance user can read it (the home "Credentials pending verification" card
 * is visible to all); the verify ACTION stays gated in the per-qualification
 * PATCH (super_admin / HR / Site Medical Head). Credentials are physician-level,
 * not hospital-scoped, so this list is network-wide regardless of hospital filter.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT q.id::text AS id, q.physician_id::text AS physician_id, p.full_name AS physician_name,
           p.primary_specialty, q.degree, q.year_completed, q.institution, q.country,
           (q.file_data IS NOT NULL) AS has_file,
           (q.file_data->>'filename') AS filename,
           q.created_at
    FROM qualifications q
    JOIN physicians p ON p.id = q.physician_id
    WHERE q.verified = false
    ORDER BY q.created_at DESC
    LIMIT 200
  `) as Array<Record<string, unknown>>;

  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}
