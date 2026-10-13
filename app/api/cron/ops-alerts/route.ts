/**
 * GET /api/cron/ops-alerts — the standing room alerts (gating/opd4-guard S3 b, c, d): recorder_off, mic_denied, no_machine. Queues rows in room_alert_outbox for the
 * Mini relay to post (lib/alerts/ops-alert.ts); one message per problem per hour. Bearer CRON_SECRET, like the other crons; absent secret -> 503 and nothing runs.
 */
import { NextResponse } from "next/server";
import { runOpsSweep } from "@/lib/alerts/ops-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  }
  return NextResponse.json(await runOpsSweep(), NO_STORE);
}
