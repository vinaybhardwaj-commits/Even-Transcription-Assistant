/**
 * GET /api/fleet/poll?wait=25 — the helper's outbound long-poll (TS-H3 #40). Auth: `Authorization: Device <JWS>` (lib/fleet/device-auth.ts).
 * 200 {ok:true, server_time, kill_switch, commands:[envelope v2]}; wait 0..25 (default 25), else 400 bad_wait. 401 <reason> (a revoked device is told so and must stop).
 * Acts on nothing: it hands out commands somebody else queued. 503 db on a database fault.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { authenticateDevice } from "@/lib/fleet/device-auth";
import { fleetError, fleetReply } from "@/lib/fleet/http";
import { longPoll, parseWait } from "@/lib/fleet/poll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 35;

export async function GET(req: NextRequest) {
  const wait = parseWait(req.nextUrl.searchParams.get("wait"));
  if (wait === null) return fleetError(400, "bad_wait");
  try {
    const auth = await authenticateDevice(sql as never, { authorization: req.headers.get("authorization"), method: "GET", path: req.nextUrl.pathname, nowMs: Date.now() });
    if (!auth.ok) return fleetError(auth.status, auth.code);
    const body = await longPoll(sql as never, auth.device.device_id, wait);
    return fleetReply(200, { ok: true, ...body });
  } catch (e) {
    console.error("[fleet-poll] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return fleetError(503, "db");
  }
}
