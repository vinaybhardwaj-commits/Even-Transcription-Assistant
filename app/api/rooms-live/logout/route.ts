/** POST /api/rooms-live/logout — expires the staff cookie. (An admin session is ended from the admin app; this does not touch it.) */
import { NextResponse } from "next/server";
import { STAFF_COOKIE, staffCookieOptions } from "@/lib/rooms-live/staff-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(STAFF_COOKIE, "", staffCookieOptions(0));
  return res;
}
