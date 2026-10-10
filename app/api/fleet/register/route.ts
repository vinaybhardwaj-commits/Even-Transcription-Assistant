/**
 * POST /api/fleet/register — bind a device's Ed25519 public key to a room install (TS-H3 #40). Wire format and rules: lib/fleet/register.ts and docs/fleet/PROTOCOL.md.
 * Auth: `Authorization: Bearer <room session JWT>` + a proof-of-possession JWS in the body. 201 first registration, 200 the same key again.
 * Errors (JSON {ok:false,error}): 400 bad_*, 401 room_auth|bad_proof|bad_signature|expired|replay|…, 403 room_mismatch|machine_mismatch, 404 unknown_install, 409 KEY_CONFLICT|REVOKED|RETIRED, 413, 503 db.
 * Acts on nothing: it writes one fleet_devices row and one fleet_audit row.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { verifyRoomJwt } from "@/lib/room-auth";
import { fleetError, fleetReply, readCapped } from "@/lib/fleet/http";
import { parseRegisterBody, registerDevice } from "@/lib/fleet/register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec((req.headers.get("authorization") ?? "").trim());
  if (!m) return fleetError(401, "room_auth");
  let roomId: string;
  try {
    roomId = (await verifyRoomJwt(m[1]!)).room_id;
    if (typeof roomId !== "string" || !roomId) return fleetError(401, "room_auth");
  } catch {
    return fleetError(401, "room_auth");
  }
  const text = await readCapped(req, 8 * 1024);
  if (text === null) return fleetError(413, "too_large");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fleetError(400, "bad_json");
  }
  const parsed = parseRegisterBody(json);
  if (!parsed.ok) return fleetError(400, parsed.code);
  try {
    const r = await registerDevice(sql as never, { roomId, body: parsed.body, nowMs: Date.now() });
    return r.ok ? fleetReply(r.status, { ok: true, ...r.body }) : fleetError(r.status, r.code);
  } catch (e) {
    console.error("[fleet-register] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return fleetError(503, "db");
  }
}
