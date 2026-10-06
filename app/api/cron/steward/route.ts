/**
 * GET /api/cron/steward — the Room Steward's one-minute SHADOW loop (lib/steward/loop.ts). vercel.json: every minute.
 *
 * P0 IS SHADOW: it senses every room, decides, and RECORDS what it would do in steward_decisions. It never calls Scribe, never issues a ticket, never sends a message.
 * Auth: Authorization: Bearer ${CRON_SECRET} (same as the other crons). Unset -> 503 and NOTHING runs; wrong or missing -> 401.
 * Response 200: { ok, rooms, decisions_written, skipped_lock, elapsed_ms, degraded[], kill_switch, budget_hit, fleet_incidents }. A tick that cannot do its work reports it in
 * `degraded` rather than failing; only a crash of the loop itself answers 500. A config without `rooms` / `schedule` (or an unreadable one) skips the tick: 200 { ok:false,
 * reason:"config_unavailable", ... } — the lease is never taken. Each tick logs one JSON line `steward.tick` and stores steward_config.last_tick.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { runSteward } from "@/lib/steward/loop";
import type { StewardSql } from "@/lib/steward/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const BUDGET_MS = 20_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  }
  try {
    const summary = await runSteward(sql as unknown as StewardSql, { asOf: Date.now(), budgetMs: BUDGET_MS });
    return NextResponse.json(summary, NO_STORE);
  } catch {
    console.error("[steward-cron] loop crashed");
    return NextResponse.json({ error: { code: "STEWARD_FAILED", message: "steward loop failed" } }, { status: 500, ...NO_STORE });
  }
}
