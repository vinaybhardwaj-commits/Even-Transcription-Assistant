/**
 * lib/brain/auth.ts — bearer auth for /api/brain/cues and /api/brain/rooms/:id/state.
 *
 * PORTED from brain/src/server.ts checkAuth() (Kickoff A2). Authorization: Bearer
 * <BRAIN_SERVICE_TOKEN>. Constant-time compare via SHA-256 digests + timingSafeEqual so a
 * length mismatch does not short-circuit. Missing env → 503 service_token_not_configured
 * (fail closed). /api/brain/health is open and does not call this.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { TOKEN_ENV } from "./db";

export type AuthFailure = { status: 401 | 503; code: "unauthorized" | "service_token_not_configured" };

/** Returns null when authorized, else the failure to send. Never throws. */
export function checkBearer(req: Request): AuthFailure | null {
  const expected = process.env[TOKEN_ENV];
  if (!expected) return { status: 503, code: "service_token_not_configured" };
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return { status: 401, code: "unauthorized" };
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? null : { status: 401, code: "unauthorized" };
}
