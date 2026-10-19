/**
 * lib/spine/auth.ts — bearer check for the spine routes (D10: the box holds a token, never a DB credential).
 * SPINE_BEARER_TOKEN unset => 503 (fails closed); missing or wrong => 401. Same rules as the S1 signals route; the merge round dedups if S1 lands its own.
 */
import { timingSafeEqual } from "node:crypto";

export function checkSpineBearer(headers: Headers, env: Record<string, string | undefined> = process.env): { status: 401 | 503; error: string } | null {
  const token = env.SPINE_BEARER_TOKEN;
  if (!token) return { status: 503, error: "spine_token_unset" };
  const m = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "");
  if (!m) return { status: 401, error: "unauthorized" };
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 401, error: "unauthorized" };
  return null;
}
