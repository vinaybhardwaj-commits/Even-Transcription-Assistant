/**
 * lib/operator-auth.ts — the bench admin routes' two doors.
 *
 * DOOR ONE is the admin cookie, exactly as it was. DOOR TWO is `Authorization: Bearer
 * ${OPERATOR_TOKEN}`, for engineering panes that have no browser. A request is let in by either.
 *
 * AN UNSET SECRET MEANS THE SECOND DOOR DOES NOT EXIST. It does not mean "no auth required" — that
 * is what lib/admin-gate.ts does in its dev mode, and it is the failure this file is shaped to
 * avoid. `operatorBearerOk` checks that the secret exists BEFORE it looks at the request, so with
 * OPERATOR_TOKEN unset, empty or whitespace, no bearer of any kind — including an empty one —
 * reaches a comparison, let alone passes one.
 *
 * Both sides are hashed with SHA-256 before `timingSafeEqual`, so a length mismatch does not
 * short-circuit (same as lib/brain/auth.ts). The token, and the presented header, are never logged
 * and never appear in a response body: a refusal is the same 401 the cookie path already gives.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";

export const OPERATOR_TOKEN_ENV = "OPERATOR_TOKEN";

/** What an operator-bearer request is recorded as. There is no admin row behind a token. */
export const OPERATOR_BEARER_PRINCIPAL = "operator_bearer";

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * TRUE only when OPERATOR_TOKEN is set to something non-blank AND the request presents exactly it.
 * Pure of I/O; never throws.
 */
export function operatorBearerOk(req: Request): boolean {
  const expected = (process.env[OPERATOR_TOKEN_ENV] ?? "").trim();
  if (expected === "") return false; // the door does not exist
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]!.trim()), sha256(expected));
}

/**
 * The admin id from a valid admin cookie, else null. UNCHANGED from the guard this replaces in
 * app/api/admin/bench/windows/route.ts.
 */
async function cookiePrincipal(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return String(c.admin_id ?? "");
  } catch {
    return null;
  }
}

/**
 * The bench admin guard: a principal string when either door opens, null when neither does.
 * The cookie is tried first so a signed-in admin is recorded as themselves, not as the token.
 */
export async function benchAdminPrincipal(req: Request): Promise<string | null> {
  const viaCookie = await cookiePrincipal();
  if (viaCookie !== null) return viaCookie;
  return operatorBearerOk(req) ? OPERATOR_BEARER_PRINCIPAL : null;
}
