/**
 * Operator gate for the destructive / maintenance routes under /api/admin/** (Round 2 / F3).
 *
 * Before: these routes sat on the middleware's ADMIN_BOOTSTRAP_ROUTES list ("the URL is the gate")
 * with no check in the handler, so anyone who knew the URL could run migrations, wipe data or
 * re-seed profiles. Now exactly two credentials open them:
 *
 *   1. a signed-in, active super_admin staff session (the UI path: the `epi_session` cookie), or
 *   2. `Authorization: Bearer ${ADMIN_OPS_TOKEN}` (deploy and smoke scripts; no session needed).
 *
 * Neither present = 401. The session's super-admin flag is re-read from the database on every request
 * (a revoked super admin keeps no ops access for the rest of the 7-day cookie); if the database cannot
 * confirm it, the session does not count (the bearer still can). Fail closed: an unset or short (< 16 chars) ADMIN_OPS_TOKEN disables the
 * bearer path, it never makes it open. The token compare is constant-time. Physician-portal
 * sessions never count as a session here.
 *
 * The routes stay on the middleware bootstrap list only so the bearer path can reach them without
 * a cookie; the handler is the gate, so EVERY handler in a gated route must call `requireOps`.
 * (A source-guard test enforces that.)
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { loadLiveStaff } from "@/lib/staff-live";

export type OpsAuth =
  | { ok: true; via: "session" | "token" }
  | { ok: false; status: 401; error: "Unauthorized" };

/** Constant-time compare (same shape as cron-auth). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PURE. Decide a request from the header, the configured token and the staff session. */
export function checkOpsAuth(
  authorization: string | null | undefined,
  token: string | undefined,
  user: { status?: unknown; is_super_admin?: unknown; kind?: unknown } | null | undefined,
): OpsAuth {
  if (user && user.kind !== "physician" && user.status === "active" && user.is_super_admin === true) {
    return { ok: true, via: "session" };
  }
  if (token && token.length >= 16 && authorization && safeEqual(authorization, `Bearer ${token}`)) {
    return { ok: true, via: "token" };
  }
  return { ok: false, status: 401, error: "Unauthorized" };
}

/** Route guard: a response to send when refused, null when the request may proceed. */
export function opsDenied(auth: OpsAuth): NextResponse | null {
  if (auth.ok) return null;
  if (!process.env.ADMIN_OPS_TOKEN) {
    console.error("[ops-auth] ADMIN_OPS_TOKEN is not set; only a super_admin session can use /api/admin ops routes");
  }
  return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
}

/**
 * Call first in every handler: `const denied = await requireOps(req); if (denied) return denied;`
 * The session lookup is best-effort (no cookie / no request scope = no session). A session whose cookie
 * claims super admin is confirmed against the database before it counts.
 */
export async function requireOps(req: Request): Promise<NextResponse | null> {
  const authorization = req.headers.get("authorization");
  const token = process.env.ADMIN_OPS_TOKEN;
  const cookieUser = await getCurrentUser().catch(() => null);

  let sessionUser: { status?: unknown; is_super_admin?: unknown; kind?: unknown } | null = null;
  const claimed = cookieUser as unknown as { profileId?: string; kind?: unknown; is_super_admin?: unknown } | null;
  if (claimed && claimed.kind !== "physician" && claimed.is_super_admin === true && claimed.profileId) {
    const live = await loadLiveStaff(claimed.profileId);
    if (live) sessionUser = { status: live.status, is_super_admin: live.is_super_admin };
  }
  return opsDenied(checkOpsAuth(authorization, token, sessionUser));
}
