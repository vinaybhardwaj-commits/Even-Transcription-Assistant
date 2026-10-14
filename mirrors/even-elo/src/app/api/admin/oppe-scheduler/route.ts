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
 * POST /api/admin/oppe-scheduler
 *
 * The recurring 6-month rollover job. Designed to be wired to Vercel cron
 * once V configures it; usable manually as an URL-gated admin endpoint until
 * then.
 *
 * For each active engagement (status='active', physician.current_status≠'terminated'):
 *   - If the engagement has any non-final OPPE (status pending|in_review):
 *     skip — a review is already on someone's plate.
 *   - Else if the most recent COMPLETED OPPE was >6 months ago, OR no OPPE
 *     exists AND start_date is >6 months ago: create a new oppe_reviews row.
 *
 * Creates with: period_start = MAX(prev_completed_period_end, NOW-6mo)
 *               period_end = NOW
 *               due_at = NOW + 30 days
 *               status='pending'
 *               packet_jsonb = snapshot of the 6-month metrics + incidents +
 *                              patient_feedback for this physician × hospital.
 *
 * URL-gated: same pattern as other /api/admin/* bootstrap endpoints. Wire to
 * Vercel cron via vercel.json + CRON_SECRET when ready (PRD §C.6).
 */
export async function POST(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Find candidate engagements
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
            AND o.status IN ('pending', 'in_review')
        )
      ) AS has_open_oppe,
      (
        SELECT MAX(completed_at)::date FROM oppe_reviews o
        WHERE o.physician_id = e.physician_id AND o.hospital_id = e.hospital_id
          AND o.status IN ('satisfactory', 'flagged', 'escalated_to_fppe')
      ) AS last_completed_at
    FROM physician_engagements e
    JOIN physicians p ON p.id = e.physician_id
    JOIN hospitals  h ON h.id = e.hospital_id
    WHERE e.status = 'active'
      AND p.current_status <> 'terminated'
      AND e.start_date <= CURRENT_DATE - INTERVAL '6 months'
  `) as Array<{
    engagement_id: string;
    physician_id: string;
    hospital_id: string;
    hospital_code: string;
    start_date: string;
    physician_name: string;
    has_open_oppe: boolean;
    last_completed_at: string | null;
  }>;

  const created: Array<{ engagement_id: string; physician_name: string; hospital_code: string; oppe_id: string }> = [];
  const skipped: Array<{ engagement_id: string; reason: string }> = [];

  for (const c of candidates) {
    if (c.has_open_oppe) {
      skipped.push({ engagement_id: c.engagement_id, reason: "open_oppe_already_exists" });
      continue;
    }

    // Determine if we need a new OPPE
    // - If last_completed_at exists and was >6mo ago → create
    // - If no last_completed_at and start_date is >6mo ago → create
    let createIt = false;
    if (c.last_completed_at) {
      const last = new Date(c.last_completed_at);
      const sixMoAgo = new Date();
      sixMoAgo.setMonth(sixMoAgo.getMonth() - 6);
      createIt = last <= sixMoAgo;
    } else {
      createIt = true; // start_date already gated to >6mo in WHERE
    }
    if (!createIt) {
      skipped.push({ engagement_id: c.engagement_id, reason: "last_oppe_within_6mo" });
      continue;
    }

    const periodEnd = new Date().toISOString().slice(0, 10);
    const periodStart = c.last_completed_at
      ? new Date(c.last_completed_at).toISOString().slice(0, 10)
      : ((): string => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().slice(0, 10); })();

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

  // Audit summary row
  await sql`
    INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
    VALUES (
      'oppe_scheduler_run',
      'system',
      'oppe_scheduler',
      ${JSON.stringify({
        created_count: created.length,
        skipped_count: skipped.length,
        candidate_count: candidates.length,
        seeded_via: "POST /api/admin/oppe-scheduler",
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

/**
 * GET /api/admin/oppe-scheduler — preview what the scheduler WOULD do
 * without writing anything.
 */
export async function GET(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      e.id::text AS engagement_id,
      p.full_name AS physician_name,
      h.code AS hospital_code,
      e.start_date,
      e.category,
      (
        SELECT MAX(completed_at)::date FROM oppe_reviews o
        WHERE o.physician_id = e.physician_id AND o.hospital_id = e.hospital_id
          AND o.status IN ('satisfactory', 'flagged', 'escalated_to_fppe')
      ) AS last_completed_at,
      (
        SELECT COUNT(*)::int FROM oppe_reviews o
        WHERE o.physician_id = e.physician_id AND o.hospital_id = e.hospital_id
          AND o.status IN ('pending', 'in_review')
      ) AS open_oppe_count
    FROM physician_engagements e
    JOIN physicians p ON p.id = e.physician_id
    JOIN hospitals  h ON h.id = e.hospital_id
    WHERE e.status = 'active'
      AND p.current_status <> 'terminated'
      AND e.start_date <= CURRENT_DATE - INTERVAL '6 months'
    ORDER BY p.full_name, h.code
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, candidates: rows }, { headers: NO_STORE });
}
