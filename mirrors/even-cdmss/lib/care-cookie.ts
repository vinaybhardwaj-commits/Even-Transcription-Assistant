import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';

// Fail-closed gate for the Care Conversation Brief surface (/care). The surface shows
// PHI-derived clinical briefs to non-clinical CARE MANAGERS, so it stays LOCKED unless the
// `cat_care` cookie matches CARE_TOKEN. If CARE_TOKEN is unset, the surface is locked
// (never open by default). Mirrors lib/pharmacist-cookie.ts / lib/admin-cookie.ts.
export const CARE_COOKIE = 'cat_care';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

export async function isCareUnlocked(): Promise<boolean> {
  const token = process.env.CARE_TOKEN;
  if (!token) return false;
  const jar = await cookies();
  const val = jar.get(CARE_COOKIE)?.value || '';
  return !!val && safeEq(val, token);
}

export function careTokenConfigured(): boolean {
  return !!process.env.CARE_TOKEN;
}

export function careTokenMatches(presented: string): boolean {
  const token = process.env.CARE_TOKEN;
  return !!token && safeEq(presented, token);
}
