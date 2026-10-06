/**
 * GET /api/cron/kiosk-health-retention — daily (vercel.json, 21:35 UTC = 03:05 IST) 30-day retention for kiosk_health_events.
 *
 * Deletes rows with received_at older than 30 days, 5000 per statement, until a statement deletes 0 rows or the 20 s budget is spent.
 * Auth: Authorization: Bearer ${CRON_SECRET} (same as the other crons). Unset → 503, wrong/missing → 401.
 * Response: 200 { deleted, batches, budget_hit } (batches counts statements that deleted rows). DB fault → 503.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const RETENTION_MS = 30 * 86_400_000;
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
  } catch {
    console.error(`[kiosk-health-retention] delete failed after ${deleted} rows in ${batches} batches`);
    return NextResponse.json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "delete failed" }, deleted, batches }, { status: 503, ...NO_STORE });
  }
  return NextResponse.json({ deleted, batches, budget_hit: budgetHit }, NO_STORE);
}
