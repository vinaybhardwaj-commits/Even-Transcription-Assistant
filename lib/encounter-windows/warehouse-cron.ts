/**
 * lib/encounter-windows/warehouse-cron.ts — the handler behind GET /api/cron/encounter-windows/warehouse.
 *
 * Every 2 minutes (vercel.json) it asks the warehouse about the consults that have no answer yet (default: windows that
 * opened in the last 36 h; see attributeFromWarehouse). `?hours=N` (1..720) widens that for a backfill; a backfill
 * works through the queue in batches of 500 until it is empty or 50 s are used, and reports complete=false when it
 * stopped early — call again, the rows already written are out of the queue, so the call resumes where it stopped.
 *
 * BEARER, NOT COOKIE — the same shape as ./cron.ts: CRON_SECRET unset -> 503 and nothing runs; wrong bearer -> 401;
 * a bad `hours` -> 400. Response: counts only. No ids, no names (the mismatches themselves are logged at info level).
 * A failure returns 500 { error: { code: "WAREHOUSE_FAILED" } } with a generic log line; batches already written stay.
 *
 * Kept out of the route file because a Next route module may export only handlers and route config.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { attributeFromWarehouse, type WarehouseSummary } from "./warehouse-attribution";

const NO_STORE = { headers: { "cache-control": "no-store" } };
const BUDGET_MS = 50_000;
const BATCH = 500;
const DEFAULT_HOURS = 36;
const bad = (message: string) => NextResponse.json({ error: { code: "VALIDATION_FAILED", message } }, { status: 400, ...NO_STORE });

export async function handleWarehouseCron(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  }

  const p = new URL(req.url).searchParams;
  let hours = DEFAULT_HOURS;
  if (p.has("hours")) {
    const raw = Number(p.get("hours"));
    if (!Number.isFinite(raw) || raw < 1) return bad("hours must be a positive number");
    hours = Math.min(Math.trunc(raw), 720);
  }

  const startedAt = Date.now();
  const deadlineMs = startedAt + BUDGET_MS;
  const total: WarehouseSummary = { candidates: 0, checked: 0, resolved: 0, unresolved: 0, mismatches: 0, raced: 0, deferred: 0 };
  let batches = 0;
  let complete = false;
  try {
    for (;;) {
      const r = await attributeFromWarehouse(sql, { hours, limit: BATCH, deadlineMs });
      batches++;
      for (const k of Object.keys(total) as Array<keyof WarehouseSummary>) total[k] += r[k];
      // A short queue is the whole queue. A full one may have more behind it; go again only while the last batch made
      // progress (rows written leave the queue) and there is budget left.
      if (r.candidates < BATCH && r.deferred === 0) { complete = true; break; }
      if (r.checked === 0 || r.deferred > 0 || Date.now() > deadlineMs) break;
    }
    return NextResponse.json({ ok: true, hours, batches, complete, ...total }, NO_STORE);
  } catch (e) {
    console.error(`[warehouse-attribution] failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return NextResponse.json({ error: { code: "WAREHOUSE_FAILED", message: "warehouse attribution failed" } }, { status: 500, ...NO_STORE });
  }
}
