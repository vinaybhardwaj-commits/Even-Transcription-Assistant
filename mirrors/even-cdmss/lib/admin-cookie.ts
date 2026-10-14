import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';

export const ADMIN_COOKIE = 'cat_admin';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

// Fail-closed gate for the observability surface (which exposes raw clinical
// queries / possible PHI). Locked unless the cat_admin cookie matches ADMIN_TOKEN.
// If ADMIN_TOKEN is unset, the surface stays LOCKED (never open by default).
export async function isAdminUnlocked(): Promise<boolean> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const jar = await cookies();
  const val = jar.get(ADMIN_COOKIE)?.value || '';
  return !!val && safeEq(val, token);
}

export function adminTokenConfigured(): boolean {
  return !!process.env.ADMIN_TOKEN;
}

/**
 * Timing-safe check of a PRESENTED admin credential against ADMIN_TOKEN, for callers that hold the
 * value directly rather than as a cookie. Exact mirror of `careTokenMatches` in lib/care-cookie.ts,
 * on the same `safeEq` — one comparison rule, three surfaces, no second implementation.
 *
 * ⚠️ FAIL-CLOSED, and the order matters: with ADMIN_TOKEN unset this is FALSE for every input,
 * including the empty string. An unconfigured deployment must not be an unlocked one.
 *
 * Its only caller is the F11 lab-origin gate (lib/lab-override.ts), which uses it to accept an
 * admin credential presented on a HEADER by the Lab MCP's own self-request. It deliberately does
 * NOT touch the cookie jar and does NOT confer a session: `isAdminUnlocked` remains the one gate
 * for the human admin surfaces, unchanged and with no new callers.
 */
export function adminTokenMatches(presented: string): boolean {
  const token = process.env.ADMIN_TOKEN;
  return !!token && !!presented && safeEq(presented, token);
}
