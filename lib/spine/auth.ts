/** lib/spine/auth.ts — bearer parsing and the timing-safe compare shared by the spine routes. */
import { createHash, timingSafeEqual } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest();

/** The token after the exact scheme "Bearer " (scheme case-insensitive), else "". Nothing else is accepted: not Basic, not a 7-char prefix. */
export function bearerToken(header: string | null): string {
  const h = header ?? "";
  return h.slice(0, 7).toLowerCase() === "bearer " ? h.slice(7).trim() : "";
}

export function bearerMatches(header: string | null, want: string): boolean {
  const got = bearerToken(header);
  return got !== "" && want !== "" && timingSafeEqual(sha(got), sha(want));
}

/**
 * The S5 claim/report routes' check (D10: the box holds a token, never a DB credential). Token env: SPINE_BEARER_TOKEN (the S1 signals route keeps its own SPINE_INGEST_TOKEN_ENV).
 * Unset => 503 (fails closed); missing or wrong => 401. Scheme and compare are the shared ones above.
 */
export function checkSpineBearer(headers: Headers, env: Record<string, string | undefined> = process.env): { status: 401 | 503; error: string } | null {
  const token = env.SPINE_BEARER_TOKEN;
  if (!token) return { status: 503, error: "spine_token_unset" };
  return bearerMatches(headers.get("authorization"), token) ? null : { status: 401, error: "unauthorized" };
}
