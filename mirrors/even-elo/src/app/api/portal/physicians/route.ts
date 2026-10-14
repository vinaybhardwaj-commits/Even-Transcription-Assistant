import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET /api/portal/physicians?q= — network-wide physician picker for peer reporting (excludes self). */
export async function GET(req: NextRequest) {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const like = `%${q}%`;
  const rows = (await sql`
    SELECT id::text AS id, full_name, primary_specialty
    FROM physicians
    WHERE current_status = 'active' AND id <> ${me.physicianId}::uuid
      AND (${q} = '' OR full_name ILIKE ${like})
    ORDER BY full_name ASC
    LIMIT 20
  `) as Array<Record<string, unknown>>;
  return portalJson({ ok: true, rows }, { headers: NO_STORE });
}
