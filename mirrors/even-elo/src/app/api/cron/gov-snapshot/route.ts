import { NextRequest, NextResponse } from "next/server";
import { cronGuard } from "@/lib/cron-auth";
import { storeSnapshot, storeIncidentSnapshot } from "@/lib/gov-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Daily governance-signal snapshot cron (PRD v1.4 §6.1) — vercel.json schedules
 * this at 00:30 UTC = 06:00 IST, after the CDMSS audit cron (~05:30 IST).
 *
 * Also the one-time backfill: GET ?from=2026-06-27&to=2026-07-01 loops days
 * (admin cookie required for backfill; plain cron invocations store just the
 * latest audited day).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` only (src/lib/cron-auth.ts). Missing CRON_SECRET
 * answers 503. Backfill (?from&to) uses the same bearer. Idempotent upserts — harmless to re-run.
 */

function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(to + "T00:00:00Z").getTime();
  for (let t = new Date(from + "T00:00:00Z").getTime(); t <= end && out.length <= 120; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export async function GET(req: NextRequest) {
  const denied = cronGuard(req, "/api/cron/gov-snapshot");
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  try {
    if (from && to) {
      const results: Array<{ day: string; ok: boolean; error?: string }> = [];
      for (const day of dayRange(from, to)) {
        try {
          const r = await storeSnapshot(day);
          results.push({ day: r.day, ok: true });
        } catch (e) {
          results.push({ day, ok: false, error: e instanceof Error ? e.message : "failed" });
        }
      }
      return NextResponse.json({ ok: true, mode: "backfill", results });
    }
    const r = await storeSnapshot();
    // Gap 2 (2 Jul): incidents join the signal spine — same daily cadence.
    let incident: { day: string; clusters: number } | { error: string };
    try {
      incident = await storeIncidentSnapshot();
    } catch (e) {
      incident = { error: e instanceof Error ? e.message : "failed" }; // OPD snapshot still counts
    }
    return NextResponse.json({ ok: true, mode: "daily", stored: r, incident });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "snapshot failed" },
      { status: 502 },
    );
  }
}
