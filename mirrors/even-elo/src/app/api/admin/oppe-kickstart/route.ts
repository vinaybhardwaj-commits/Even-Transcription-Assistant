import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { buildOppePacket } from "@/lib/oppe-packet";
import { requireOps } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST /api/admin/oppe-kickstart
 *
 * Decision #21 in the credentialing PRD. One-shot button (rendered on /admin
 * for super_admin) that creates an OPPE row for EVERY existing Active
 * engagement that doesn't already have an open OPPE. Use this when the team's
 * ready to take on the review work for the first time.
 *
 * The recurring scheduler (POST /api/admin/oppe-scheduler) only creates rows
 * for engagements past their 6mo cycle. The kickstart ignores timing and
 * gives every active engagement a baseline OPPE due in 30 days.
 *
 * URL-gated. Safe to re-run: skips engagements that already have an open
 * OPPE.
 */
export async function POST(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const candidates = (await sql`
    SELECT
      e.id::text AS engagement_id,
      e.physician_id::text AS physician_id,
      e.hospital_id::text AS hospital_id,
      h.code AS hospital_code,
      e.start_date::text AS start_date,
      p.full_name AS physician_name,
      (
        SELECT EXISTS (
          SELECT 1 FROM oppe_reviews o
          WHERE o.physician_id = e.physician_id AND o.hospital_id = e.hospital_id
            AND o.status IN ('pending','in_review')
        )
      ) AS has_open_oppe
    FROM physician_engagements e
    JOIN physicians p ON p.id = e.physician_id
    JOIN hospitals  h ON h.id = e.hospital_id
    WHERE e.status = 'active'
      AND p.current_status <> 'terminated'
  `) as Array<{
    engagement_id: string;
    physician_id: string;
    hospital_id: string;
    hospital_code: string;
    start_date: string;
    physician_name: string;
    has_open_oppe: boolean;
  }>;

  const created: Array<{ engagement_id: string; physician_name: string; hospital_code: string; oppe_id: string }> = [];
  const skipped: Array<{ engagement_id: string; reason: string }> = [];

  const periodEnd = new Date().toISOString().slice(0, 10);

  for (const c of candidates) {
    if (c.has_open_oppe) {
      skipped.push({ engagement_id: c.engagement_id, reason: "open_oppe_already_exists" });
      continue;
    }

    // For brand-new engagements (start_date < 6mo), period_start = start_date.
    // For long-tenured engagements, period_start = NOW - 6mo so the packet
    // window matches the cadence.
    const sixMoAgo = new Date();
    sixMoAgo.setMonth(sixMoAgo.getMonth() - 6);
    const sixMoAgoStr = sixMoAgo.toISOString().slice(0, 10);
    const periodStart = c.start_date > sixMoAgoStr ? c.start_date : sixMoAgoStr;

    const packet = await buildOppePacket(sql, c.physician_id, c.hospital_id, periodStart, periodEnd);

    const ins = (await sql`
      INSERT INTO oppe_reviews (
        physician_id, hospital_id, period_start, period_end, due_at, status, packet_jsonb
      ) VALUES (
        ${c.physician_id}::uuid, ${c.hospital_id}::uuid, ${periodStart}::date, ${periodEnd}::date,
        (NOW() + INTERVAL '30 days'), 'pending', ${JSON.stringify(packet)}::jsonb
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    created.push({
      engagement_id: c.engagement_id,
      physician_name: c.physician_name,
      hospital_code: c.hospital_code,
      oppe_id: ins[0].id,
    });
  }

  await sql`
    INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
    VALUES (
      'oppe_kickstart',
      'system',
      'oppe_backlog',
      ${JSON.stringify({
        created_count: created.length,
        skipped_count: skipped.length,
        candidate_count: candidates.length,
        seeded_via: "POST /api/admin/oppe-kickstart",
      })}::jsonb
    )
  `;

  return NextResponse.json(
    {
      ok: true,
      candidate_count: candidates.length,
      created_count: created.length,
      skipped_count: skipped.length,
      created,
      skipped,
    },
    { headers: NO_STORE },
  );
}
