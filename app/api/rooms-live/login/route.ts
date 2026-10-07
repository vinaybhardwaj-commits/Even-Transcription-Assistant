/**
 * POST /api/rooms-live/login { pin, name } — the OPD-staff login (SPEC-v1 AMENDMENT 2). bcrypt PIN against env ROOMS_LIVE_STAFF_PIN_HASH; every attempt is counted before bcrypt and forgiven on success (net: only FAILED attempts count),
 * 10 a minute per IP (per server instance, in memory: see lib/rooms-live/staff-auth.ts), every failure is the same 401 so the answer does not say which part was wrong.
 * Sets the cookie eta_staff_session (HttpOnly, Secure, SameSite=Lax, Path=/, 12 h), signed with JWT_SECRET_STAFF.
 */
import { NextResponse } from "next/server";
import { STAFF_COOKIE, STAFF_TTL_S, cleanName, clientIp, beginAttempt, forgiveAttempt, pinOk, signStaffJwt, staffCookieOptions } from "@/lib/rooms-live/staff-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request) {
  const ip = clientIp(req);
  // F26: the attempt is counted here, synchronously, BEFORE any bcrypt work; success forgives it below
  if (!beginAttempt(ip)) return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many tries. Wait a minute." } }, { status: 429, headers: { ...NO_STORE, "retry-after": "60" } });
  let body: { pin?: unknown; name?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* an unreadable body is a failed login like any other */
  }
  const name = cleanName(body?.name);
  const ok = await pinOk(body?.pin);
  if (!ok || !name) {
    return NextResponse.json({ error: { code: "BAD_LOGIN", message: "That PIN or name did not work." } }, { status: 401, headers: NO_STORE });
  }
  forgiveAttempt(ip);
  let jwt: string;
  try {
    jwt = await signStaffJwt(name);
  } catch {
    console.error("[rooms-live] staff login not configured (JWT_SECRET_STAFF)");
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "Staff login is not set up yet." } }, { status: 503, headers: NO_STORE });
  }
  const res = NextResponse.json({ ok: true, name }, { headers: NO_STORE });
  res.cookies.set(STAFF_COOKIE, jwt, staffCookieOptions(STAFF_TTL_S));
  return res;
}
