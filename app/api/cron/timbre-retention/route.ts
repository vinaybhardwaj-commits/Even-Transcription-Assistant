/**
 * GET /api/cron/timbre-retention — daily (vercel.json, 21:50 UTC = 03:20 IST) 36-month retention for the Timbre tables
 * (lib/timbre/retention.ts; Vinay's ruling 11 Oct 2026). TIMBRE_RETENTION=0 switches it off (200 { enabled:false }).
 * Auth: Authorization: Bearer ${CRON_SECRET} (same as the other crons). Unset → 503, wrong/missing → 401. DB fault → 503.
 */
import { NextResponse } from "next/server";
import { purgeTimbre } from "@/lib/timbre/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  }
  try {
    return NextResponse.json(await purgeTimbre(), NO_STORE);
  } catch (e) {
    return NextResponse.json({ error: { code: "DB", message: `db:${(e as { code?: string }).code ?? "unknown"}` } }, { status: 503, ...NO_STORE });
  }
}
