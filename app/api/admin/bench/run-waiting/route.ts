/**
 * POST /api/admin/bench/run-waiting — §3.10 (Build 3 §2.1): run a room's waiting audio.
 *
 * WHAT IT IS. The recovery control behind "run this room's waiting audio". It processes finished
 * pieces that have no job at all — the exact state Cardiology's seventeen were in on 24 August,
 * when the card said "17 waiting" and nothing had ever been enqueued, so there was no queue for
 * them to wait in and no control anywhere would run them. Oldest first, in one bounded batch.
 *
 * WHY ITS OWN ROUTE, and not a mode on the transcription route next door: the page never says the
 * name of that machine (§3, the vocabulary rule), and a monitor that fetched a URL carrying that
 * word would say it in the network tab. This path is named for what an operator does — run what is
 * waiting — and nothing else.
 *
 * EVERY WINDOW IN IT IS A PAID CALL, asked for by a person pressing the button. Nothing schedules
 * this, the batch is small so it finishes inside one request, and the answer reports engine,
 * characters, seconds and cost per piece so the operator sees what the batch spent before running
 * more. `remaining` says how many are still waiting.
 *
 * Admin cookie only, like every write on this page. The switch still decides: the per-piece guard
 * is inside the drainer, so a room with Transcript off runs nothing.
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { drainRoomWaitingWindows, countRoomWaitingWindows } from "@/lib/stt/room-drain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function guard(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return String(c.admin_id ?? "");
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if ((await guard()) === null) return respondError("AUTH_REQUIRED", "Sign in required");
  let body: { room_id?: unknown; limit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const roomId = typeof body.room_id === "string" ? body.room_id : "";
  if (!roomId.startsWith("room_")) return respondError("VALIDATION_FAILED", "bad_room_id");
  const batch = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 4;

  const origin = new URL(req.url).origin;
  const drained = await drainRoomWaitingWindows(roomId, origin, batch);
  const remaining = await countRoomWaitingWindows(roomId);
  return respondOk({ drained, remaining });
}
