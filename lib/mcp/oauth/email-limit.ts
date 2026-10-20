/**
 * lib/mcp/oauth/email-limit.ts — the per-IP limiter for POST /api/oauth/email/start (10 starts per 15 min), the register-limit pattern: in memory, per instance, and in its own module because a
 * Next route module may export only the route fields. The per-ADDRESS limit (3 codes per 15 min) lives in the database (store.insertEmailCode), where it holds across instances.
 */
import { EMAIL_RATE_PER_IP, EMAIL_RATE_WINDOW_S } from "./config";

const hits = new Map<string, { n: number; reset: number }>();

/** True when this IP has used up its starts for the current window. Counts every start, qualifying address or not. */
export function emailStartLimited(ip: string, now: number = Date.now()): boolean {
  const h = hits.get(ip);
  if (!h || now >= h.reset) {
    hits.set(ip, { n: 1, reset: now + EMAIL_RATE_WINDOW_S * 1000 });
    if (hits.size > 2000) for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
    return false;
  }
  h.n += 1;
  return h.n > EMAIL_RATE_PER_IP;
}

export function resetEmailLimitForTests(): void {
  hits.clear();
}
