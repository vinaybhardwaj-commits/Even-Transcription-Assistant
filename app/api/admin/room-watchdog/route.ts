/**
 * GET /api/admin/room-watchdog — the Room Watchdog's cron door (ORB3, 12-13 Sep 2026).
 *
 * D6 NO QUIET HOURS. This is a theatre; 03:00 is exactly when nobody is looking. The cron in
 * vercel.json runs it every minute, all day, every day.
 *
 * BEARER, NOT COOKIE — the same shape as app/api/jobs/run/route.ts, read first and followed here
 * rather than invented fresh. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, which carries
 * no session, so a cookie guard would refuse every real invocation. CRON_SECRET absent -> 503 and
 * NOTHING runs: a watchdog that authorised everyone because its secret was unset would let any
 * caller trigger a run (and, worse, its writes) on demand.
 *
 * NEVER THROWS TO THE CALLER. `runWatchdog` already fails safe on its own read (see lib/room-
 * watchdog.ts): an unreachable database logs loudly and sends nothing rather than guessing.
 */
import { NextResponse } from "next/server";
import { runWatchdog } from "@/lib/room-watchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: { code: "WATCHDOG_NOT_CONFIGURED", message: "CRON_SECRET is not set" } },
      { status: 503, ...NO_STORE },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "cron bearer required" } },
      { status: 401, ...NO_STORE },
    );
  }

  const result = await runWatchdog();
  return NextResponse.json(result, NO_STORE);
}
