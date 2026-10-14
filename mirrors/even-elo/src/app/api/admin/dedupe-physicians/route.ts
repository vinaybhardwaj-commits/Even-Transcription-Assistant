import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST /api/admin/dedupe-physicians
 *
 * For each group of physicians sharing the same lower(full_name), keep the
 * one with the earliest created_at and hard-DELETE the others (the FK
 * CASCADE on physician_engagements + qualifications + privileges +
 * oppe_reviews + privilege_requests handles the rest).
 *
 * URL-gated. Returns kept + deleted summary. Audited.
 */
export async function POST(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Find groups of duplicates by lower(full_name)
  const groups = (await sql`
    SELECT lower(full_name) AS name_key, COUNT(*)::int AS n
    FROM physicians
    GROUP BY lower(full_name)
    HAVING COUNT(*) > 1
  `) as Array<{ name_key: string; n: number }>;

  const deleted: Array<{ name_key: string; deleted_id: string; created_at: string }> = [];
  const kept: Array<{ name_key: string; kept_id: string; created_at: string }> = [];

  for (const g of groups) {
    // Order by created_at ASC — keep the first (oldest), delete the rest
    const rows = (await sql`
      SELECT id::text AS id, created_at, email
      FROM physicians
      WHERE lower(full_name) = ${g.name_key}
      ORDER BY created_at ASC, id ASC
    `) as Array<{ id: string; created_at: string; email: string | null }>;

    kept.push({ name_key: g.name_key, kept_id: rows[0].id, created_at: rows[0].created_at });
    for (let i = 1; i < rows.length; i++) {
      const toDelete = rows[i];
      await sql`DELETE FROM physicians WHERE id = ${toDelete.id}::uuid`;
      deleted.push({ name_key: g.name_key, deleted_id: toDelete.id, created_at: toDelete.created_at });
    }
  }

  await sql`
    INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
    VALUES (
      'dedupe_physicians',
      'system',
      'dedupe_run',
      ${JSON.stringify({
        groups_processed: groups.length,
        kept_count: kept.length,
        deleted_count: deleted.length,
        deleted_ids: deleted.map((d) => d.deleted_id),
        seeded_via: "POST /api/admin/dedupe-physicians",
      })}::jsonb
    )
  `;

  return NextResponse.json(
    {
      ok: true,
      groups_processed: groups.length,
      kept_count: kept.length,
      deleted_count: deleted.length,
      kept,
      deleted,
    },
    { headers: NO_STORE },
  );
}
