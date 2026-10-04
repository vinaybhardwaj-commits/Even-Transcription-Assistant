/**
 * GET /api/cron/encounter-windows — recompute eta_encounter_windows for the last 48 hours.
 *
 * BEARER, NOT COOKIE — same shape as app/api/admin/room-watchdog/route.ts: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` and carries no session. CRON_SECRET unset -> 503 and NOTHING runs; wrong
 * bearer -> 401. vercel.json runs it every 5 minutes.
 *
 * The recompute is idempotent (delete rows with t_open in range, insert fresh, one transaction), so a retried or
 * overlapping run converges on the same rows. Optional ?hours=N (1..720, default 48) widens the window for a
 * backfill; it needs the same bearer.
 *
 * Response: counts only — consults, unpaired_refs, by_quality, by_attribution, by_close_reason. No ids, no names.
 * A failure returns 500 { error: { code: "REFRESH_FAILED" } } and logs a generic reason: the previous rows stay
 * (the delete and insert are one transaction), so a failed run never leaves a hole.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { refreshWindows } from "@/lib/encounter-windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const DEFAULT_HOURS = 48;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  }

  const raw = Number(new URL(req.url).searchParams.get("hours") ?? DEFAULT_HOURS);
  const hours = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 720) : DEFAULT_HOURS;
  const now = Date.now();
  try {
    const r = await refreshWindows(sql, { from: now - hours * 3_600_000, to: now + 5 * 60_000 }, { asOf: now });
    return NextResponse.json(
      {
        ok: true,
        hours,
        range: r.range,
        events: r.events,
        deleted: r.deleted,
        inserted: r.inserted,
        consults: r.summary.consults,
        unpaired_refs: r.summary.unpaired_refs,
        by_quality: r.summary.by_quality,
        by_attribution: r.summary.by_attribution,
        by_close_reason: r.summary.by_close_reason,
      },
      NO_STORE,
    );
  } catch (e) {
    console.error(`[encounter-windows] refresh failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return NextResponse.json({ error: { code: "REFRESH_FAILED", message: "refresh failed" } }, { status: 500, ...NO_STORE });
  }
}
