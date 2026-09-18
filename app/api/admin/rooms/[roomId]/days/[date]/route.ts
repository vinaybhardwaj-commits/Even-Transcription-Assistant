/**
 * GET /api/admin/rooms/{roomId}/days/{date} - the room-day tape (S1, section 4/section 9).
 *
 * Every admin API route re-does its own auth guard rather than relying on the page's check
 * (app/api/admin/encounters/[id]/route.ts:24-32). READ ONLY: this route issues no writes,
 * directly or through the helper it calls.
 */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { getRoomDayTape } from "@/lib/room-day/admin";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function guard(): Promise<{ ok: true } | { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string }> {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    await verifyAdminJwt(cookie);
    return { ok: true };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ roomId: string; date: string }> }) {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  const { roomId, date } = await params;
  if (!IST_DATE_RE.test(date)) return respondError("VALIDATION_FAILED", "bad_ist_date");

  const tape = await getRoomDayTape(roomId, date);
  if (!tape) return respondError("NOT_FOUND", "room_day_not_found");

  return respondOk({ tape });
}
