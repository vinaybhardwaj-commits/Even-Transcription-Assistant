/**
 * POST /api/room-recorder/enrol — spend the token, get the room (PRD §4.2, §4.5, D9, D10).
 *
 * Called by the `enrol` CLI verb from inside the bootstrap script, on the room Mac, seconds after
 * the same token fetched that script. Unauthenticated for the same reason the fetch is: the token
 * is the only credential that exists on a machine which has never seen this system.
 *
 * ─── WHAT ONE CALL DOES, ATOMICALLY ──────────────────────────────────────────────────────
 * Marks the token used, sets `enrolled_at` and `session_expires_at` on the install the token
 * names, retires any other live install of that room, and returns a room session JWT with a
 * 365-DAY TTL. All four, or none — see `enrolWithToken` for why it is two ordered statements in
 * one transaction rather than one clever statement.
 *
 * ─── 365 DAYS, AND WHY THAT IS NOT THE HUMAN NUMBER ──────────────────────────────────────
 * D10. A PIN login in a browser is 30 days and stays 30 days. An installed app has nobody
 * watching it: a 30-day session would put all four rooms dark one month after install, silently,
 * with the 401s landing in a log nobody reads. There is no refresh route by design — re-enrolment
 * is a second paste, which is a decision a person makes, not a token that renews itself.
 *
 * A REPLAYED TOKEN IS TOKEN_INVALID. Acceptance item 6 posts the same token twice and requires the
 * second to fail; that is enforced in the statement, not by a check that could race.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  ENROL_RATE_LIMIT,
  clientKey,
  enrolWithToken,
  installError,
  installErrorFrom,
  rateLimited,
} from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function POST(req: NextRequest) {
  if (rateLimited(`enrol:${clientKey(req)}`, ENROL_RATE_LIMIT)) {
    return installError("ENROL_RATE_LIMITED", "too many enrolment attempts, try again shortly");
  }

  let token = "";
  try {
    const body = (await req.json()) as { token?: unknown };
    token = typeof body?.token === "string" ? body.token.trim() : "";
  } catch {
    return installError("TOKEN_INVALID", "body must be JSON carrying { token }");
  }
  if (!/^[0-9a-f]{16,128}$/.test(token)) {
    return installError("TOKEN_INVALID", "token is unknown, expired or already used");
  }

  try {
    const result = await enrolWithToken(token);
    return NextResponse.json(result, NO_STORE);
  } catch (e) {
    return installErrorFrom(e);
  }
}
