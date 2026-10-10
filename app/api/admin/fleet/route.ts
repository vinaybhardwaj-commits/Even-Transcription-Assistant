/**
 * GET /api/admin/fleet — Bench's read-only view of the helper fleet (TS-H13 #50): devices, last poll, queued/delivered/done/expired counts, the last 20 commands per device
 * with their outcomes, and the newest audit rows. Admin cookie only. No signatures, nonces, keys or result details. ?room=<room_id> narrows to one room. Sends nothing to any Mac.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { fleetAudit, fleetCommands, fleetDevices } from "@/lib/fleet/read";
import { fleetError, fleetReply } from "@/lib/fleet/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return fleetError(401, "admin_required");
  try {
    await verifyAdminJwt(cookie);
  } catch {
    return fleetError(401, "admin_required");
  }
  const room = req.nextUrl.searchParams.get("room");
  const roomId = room && /^[A-Za-z0-9_-]{1,64}$/.test(room) ? room : null;
  try {
    const [devices, commands, audit] = await Promise.all([fleetDevices(sql as never, roomId), fleetCommands(sql as never, { roomId }), fleetAudit(sql as never, 30)]);
    return fleetReply(200, { ok: true, generated_at: new Date().toISOString(), devices, commands, audit });
  } catch (e) {
    console.error("[admin-fleet] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return fleetError(503, "db");
  }
}
