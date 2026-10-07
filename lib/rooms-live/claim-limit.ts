/**
 * lib/rooms-live/claim-limit.ts — the per-IP limiter for POST /api/rooms-live/claims now that the page is open: 30 requests a minute per client IP,
 * in memory, PER SERVER INSTANCE (a serverless fleet has several; the real ceiling is 30 x instances). Every POST counts, successful or not.
 */
export const CLAIM_LIMIT = 30;
export const CLAIM_WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

/** true = allowed (and counted); false = this IP already made CLAIM_LIMIT requests inside the window (nothing recorded) */
export function claimAllowed(ip: string, now: number = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < CLAIM_WINDOW_MS);
  if (recent.length >= CLAIM_LIMIT) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= CLAIM_WINDOW_MS)) hits.delete(k);
  return true;
}

export function resetClaimLimitForTests(): void {
  hits.clear();
}
