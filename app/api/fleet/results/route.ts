/**
 * POST /api/fleet/results — a device reports the outcome of one command (TS-H3 #40). Auth: `Authorization: Device <JWS>` whose `bsha` binds the exact body.
 * 200 {ok:true, duplicate} · 400 bad_* · 401 <reason> · 403 device_mismatch · 404 unknown_command (also: a command issued to another device) · 409 not_delivered|RESULT_CONFLICT · 413 · 503 db.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { authenticateDevice } from "@/lib/fleet/device-auth";
import { fleetError, fleetReply, readCapped } from "@/lib/fleet/http";
import { MAX_BODY_BYTES, parseResultBody, recordResult } from "@/lib/fleet/results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  const text = await readCapped(req, MAX_BODY_BYTES);
  if (text === null) return fleetError(413, "too_large");
  try {
    const auth = await authenticateDevice(sql as never, { authorization: req.headers.get("authorization"), method: "POST", path: req.nextUrl.pathname, bodyText: text, nowMs: Date.now() });
    if (!auth.ok) return fleetError(auth.status, auth.code);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fleetError(400, "bad_json");
    }
    const parsed = parseResultBody(json);
    if (!parsed.ok) return fleetError(400, parsed.code);
    const r = await recordResult(sql as never, auth.device.device_id, auth.device.machine, parsed.body);
    return r.ok ? fleetReply(200, { ok: true, duplicate: r.duplicate }) : fleetError(r.status, r.code);
  } catch (e) {
    console.error("[fleet-results] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return fleetError(503, "db");
  }
}
