/**
 * lib/mcp/oauth/register-limit.ts — the per-IP limiter for POST /api/oauth/register. It lives here, not in the route file, because a Next route module may export only
 * GET/POST/... and runtime/dynamic/...: any other export fails `next build` ("not a valid Route export field").
 */
export const REGISTER_LIMIT = 10;
export const REGISTER_WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; reset: number }>();

/** True when this IP has used up its registrations for the current minute. In memory, per instance. */
export function registerLimited(ip: string, now: number = Date.now()): boolean {
  const h = hits.get(ip);
  if (!h || now >= h.reset) {
    hits.set(ip, { n: 1, reset: now + REGISTER_WINDOW_MS });
    if (hits.size > 2000) for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
    return false;
  }
  h.n += 1;
  return h.n > REGISTER_LIMIT;
}

export function resetRegisterLimitForTests(): void {
  hits.clear();
}
