/**
 * GET /api/cron/kiosk-health-retention — daily (vercel.json, 21:35 UTC = 03:05 IST) 30-day retention for kiosk_health_events.
 *
 * Deletes rows with received_at older than 30 days, 5000 per statement, until a statement deletes 0 rows or the 20 s budget is spent.
 * Room Steward (0128), same budget, after the kiosk rows: steward_nonces older than 7 days (seen_at) and steward_decisions older than 30 days (ts), then outstanding steward_tickets past expires_at are flipped to expired (so a machine that never polls again does not pin rows), then finished steward_tickets
 * (status done|failed|expired, completed_at or else expires_at older than 30 days). Decisions go first: tickets.decision_id is ON DELETE SET NULL.
 * Auth: Authorization: Bearer ${CRON_SECRET} (same as the other crons). Unset → 503, wrong/missing → 401.
 * Response: 200 { deleted, batches, budget_hit, steward_nonces_deleted, steward_decisions_deleted, steward_tickets_deleted, steward_tickets_expired } (batches counts kiosk statements that deleted rows). DB fault → 503.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const RETENTION_MS = 30 * 86_400_000;
const NONCE_RETENTION_MS = 7 * 86_400_000;
const BUDGET_MS = 20_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  }

  const startedAt = Date.now();
  const cutoff = new Date(startedAt - RETENTION_MS).toISOString();
  let deleted = 0;
  let batches = 0;
  let budgetHit = false;
  let noncesDeleted = 0;
  let decisionsDeleted = 0;
  let ticketsDeleted = 0;
  let ticketsExpired = 0;
  try {
    for (;;) {
      if (Date.now() - startedAt >= BUDGET_MS) {
        budgetHit = true;
        break;
      }
      const rows = (await sql`
        DELETE FROM kiosk_health_events
         WHERE id IN (SELECT id FROM kiosk_health_events WHERE received_at < ${cutoff}::timestamptz ORDER BY id LIMIT 5000)
        RETURNING id
      `) as Array<{ id: number }>;
      if (rows.length === 0) break;
      deleted += rows.length;
      batches++;
    }
    const nonceCutoff = new Date(startedAt - NONCE_RETENTION_MS).toISOString();
    while (!budgetHit) {
      if (Date.now() - startedAt >= BUDGET_MS) {
        budgetHit = true;
        break;
      }
      const rows = (await sql`
        DELETE FROM steward_nonces
         WHERE nonce IN (SELECT nonce FROM steward_nonces WHERE seen_at < ${nonceCutoff}::timestamptz ORDER BY seen_at LIMIT 5000)
        RETURNING nonce
      `) as Array<{ nonce: string }>;
      if (rows.length === 0) break;
      noncesDeleted += rows.length;
    }
    while (!budgetHit) {
      if (Date.now() - startedAt >= BUDGET_MS) {
        budgetHit = true;
        break;
      }
      const rows = (await sql`
        DELETE FROM steward_decisions
         WHERE id IN (SELECT id FROM steward_decisions WHERE ts < ${cutoff}::timestamptz ORDER BY id LIMIT 5000)
        RETURNING id
      `) as Array<{ id: number }>;
      if (rows.length === 0) break;
      decisionsDeleted += rows.length;
    }
    while (!budgetHit) {
      if (Date.now() - startedAt >= BUDGET_MS) {
        budgetHit = true;
        break;
      }
      const rows = (await sql`
        UPDATE steward_tickets SET status = 'expired'
         WHERE ticket_id IN (SELECT ticket_id FROM steward_tickets
                              WHERE status IN ('issued', 'fetched') AND expires_at < now()
                              ORDER BY ticket_id LIMIT 5000)
        RETURNING ticket_id
      `) as Array<{ ticket_id: string }>;
      if (rows.length === 0) break;
      ticketsExpired += rows.length;
    }
    while (!budgetHit) {
      if (Date.now() - startedAt >= BUDGET_MS) {
        budgetHit = true;
        break;
      }
      const rows = (await sql`
        DELETE FROM steward_tickets
         WHERE ticket_id IN (SELECT ticket_id FROM steward_tickets
                              WHERE status IN ('done', 'failed', 'expired') AND COALESCE(completed_at, expires_at) < ${cutoff}::timestamptz
                              ORDER BY ticket_id LIMIT 5000)
        RETURNING ticket_id
      `) as Array<{ ticket_id: string }>;
      if (rows.length === 0) break;
      ticketsDeleted += rows.length;
    }
  } catch {
    console.error(`[kiosk-health-retention] delete failed after ${deleted} rows in ${batches} batches`);
    return NextResponse.json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "delete failed" }, deleted, batches }, { status: 503, ...NO_STORE });
  }
  return NextResponse.json(
    { deleted, batches, budget_hit: budgetHit, steward_nonces_deleted: noncesDeleted, steward_decisions_deleted: decisionsDeleted, steward_tickets_deleted: ticketsDeleted, steward_tickets_expired: ticketsExpired },
    NO_STORE,
  );
}
