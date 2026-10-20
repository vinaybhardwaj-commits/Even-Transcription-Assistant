/** lib/spine/auth.ts — bearer parsing and the timing-safe compare shared by the two spine routes. */
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
