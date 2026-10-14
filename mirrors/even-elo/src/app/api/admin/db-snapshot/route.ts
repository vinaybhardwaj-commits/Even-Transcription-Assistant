import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "no DATABASE_URL" }, { status: 500 });
  const sql = neon(url);
  const counts = await sql`
    SELECT
      (SELECT count(*) FROM vcs)::int AS vcs,
      (SELECT count(*) FROM surgical_cases)::int AS cases,
      (SELECT count(*) FROM case_observations)::int AS observations,
      (SELECT count(*) FROM score_snapshots)::int AS snapshots,
      (SELECT count(*) FROM hospitals)::int AS hospitals,
      (SELECT count(*) FROM positions)::int AS positions,
      (SELECT count(*) FROM physicians)::int AS physicians,
      (SELECT count(*) FROM profiles)::int AS profiles,
      (SELECT string_agg(full_name, ', ') FROM vcs LIMIT 5) AS sample_vcs,
      now() AS db_now
  `;
  return NextResponse.json({ ok: true, counts: counts[0], generated_at: new Date().toISOString() });
}
